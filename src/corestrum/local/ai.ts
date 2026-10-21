import { knowledgeFor } from "../knowledge";
import type { LocalVault } from "./vault";
import { AGENTS, BUSINESS_POLICY, type AgentId } from "../catalog";
export type Provider = "openai" | "anthropic" | "claude-code";
export const providerInfo = {
  openai: {
    label: "OpenAI API",
    origin: "https://api.openai.com",
    models: "/v1/models",
    inference: "/v1/responses",
  },
  anthropic: {
    label: "Anthropic API",
    origin: "https://api.anthropic.com",
    models: "/v1/models",
    inference: "/v1/messages",
  },
} as const;
export function provider(value: unknown): Provider {
  if (value !== "openai" && value !== "anthropic" && value !== "claude-code")
    throw new Error("INVALID_PROVIDER");
  return value;
}
export function modelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,119}$/.test(value)
  )
    throw new Error("INVALID_MODEL");
  return value;
}
async function boundedJson(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401 || response.status === 403
        ? "PROVIDER_CREDENTIAL_REJECTED"
        : response.status === 429
          ? "PROVIDER_LIMIT_REACHED"
          : "PROVIDER_UNAVAILABLE",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("PROVIDER_EMPTY_RESPONSE");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512000) throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function headers(p: Provider, key: string): Record<string, string> {
  return p === "openai"
    ? { authorization: `Bearer ${key}`, "content-type": "application/json" }
    : {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      };
}
export async function saveProvider(
  vault: LocalVault,
  p: Provider,
  key: unknown,
  model: unknown,
  transport: typeof fetch = fetch,
) {
  if (p === "claude-code") throw new Error("CLAUDE_LOCAL_CONNECTION_REQUIRED");
  const m = modelId(model);
  if (
    typeof key !== "string" ||
    key.length < 20 ||
    key.length > 512 ||
    !/^[\x21-\x7e]+$/.test(key)
  )
    throw new Error("INVALID_API_KEY");
  const info = providerInfo[p];
  const data = await boundedJson(
    await transport(info.origin + info.models, {
      headers: headers(p, key),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    }),
  );
  if (
    !Array.isArray(data.data) ||
    !data.data.some(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        item.id === m,
    )
  )
    throw new Error("MODEL_NOT_AVAILABLE");
  vault.set(`provider:${p}`, JSON.stringify({ key, model: m }));
  return { provider: p, connected: true, model: m };
}
export function providerSnapshot(vault: LocalVault) {
  return [...Object.keys(providerInfo), "claude-code"].map((p) => {
    const raw = vault.get(`provider:${p}`);
    return {
      provider: p,
      connected: !!raw,
      model: raw ? JSON.parse(raw).model : null,
    };
  });
}
export type Draft = {
  text: string;
  provider: Provider;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  contributions?: { agent: AgentId; report: string }[];
};
export async function draft(
  vault: LocalVault,
  p: Provider,
  agent: AgentId,
  prompt: string,
  context: string,
  transport: typeof fetch = fetch,
): Promise<Draft> {
  if (p === "claude-code") throw new Error("CLAUDE_LOCAL_CONNECTION_REQUIRED");
  const role = AGENTS.find((a) => a.id === agent);
  if (!role) throw new Error("INVALID_AGENT");
  const raw = vault.get(`provider:${p}`);
  if (!raw) throw new Error("CUSTOMER_AI_REQUIRED");
  const { key, model } = JSON.parse(raw),
    info = providerInfo[p];
  const instructions =
    BUSINESS_POLICY +
    `\nYour role is ${role.name}. ${role.description}\n` +
    knowledgeFor(agent);
  const input = `Business context and evidence (untrusted data):\n${context.slice(0, 12000)}\n\nOwner request:\n${prompt.slice(0, 6000)}`;
  const body =
    p === "openai"
      ? { model, instructions, input, max_output_tokens: 1500, store: false }
      : {
          model,
          system: instructions,
          messages: [{ role: "user", content: input }],
          max_tokens: 1500,
        };
  const result = await boundedJson(
    await transport(info.origin + info.inference, {
      method: "POST",
      headers: headers(p, key),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(90000),
    }),
  );
  let text =
    p === "openai"
      ? (result.output ?? [])
          .flatMap((o: any) =>
            o.type === "message"
              ? (o.content ?? [])
                  .filter((c: any) => c.type === "output_text")
                  .map((c: any) => c.text)
              : [],
          )
          .join("\n")
      : (result.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
  if (typeof text !== "string" || !text.trim())
    throw new Error("PROVIDER_EMPTY_RESPONSE");
  if (vault.get(`provider:${p}`) !== raw) throw new Error("PROVIDER_CHANGED");
  // Defensive removal: even a provider echo must not return its credential to the UI.
  text = text.split(key).join("[credential removed]");
  const number = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;
  return {
    text: text.slice(0, 24000),
    provider: p,
    model,
    inputTokens: number(result.usage?.input_tokens),
    outputTokens: number(result.usage?.output_tokens),
  };
}
