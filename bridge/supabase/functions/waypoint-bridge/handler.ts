import { importJWK, jwtVerify, type JWK } from "jose";

export type Binding = {
  installation: string;
  org: string;
  project_ref: string;
  version: number;
  public_key: JWK;
  active: boolean;
  accounts: string[];
};
export interface BridgeStore {
  binding(): Promise<Binding | null>;
  consume(nonce: string, installation: string, expires: number): Promise<void>;
  read(
    resource: string,
    account: string,
  ): Promise<{
    id: string;
    account_id: string;
    title: string;
    status: string;
    version: number;
  } | null>;
}
export const bridgeEndpoint = (project: string) => {
  if (!/^[a-z]{20}$/.test(project)) throw new Error("INVALID_PROJECT_REF");
  return `https://${project}.supabase.co/functions/v1/waypoint-bridge`;
};
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function bridgeHandler(store: BridgeStore, project: string) {
  const audience = bridgeEndpoint(project);
  return async (req: Request) => {
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    try {
      if (
        req.method !== "POST" ||
        req.headers.get("content-type") !== "application/json"
      )
        return response({ error: "INVALID_REQUEST" }, 400);
      const token = req.headers
        .get("authorization")
        ?.match(/^Bearer ([A-Za-z0-9_.-]{1,8192})$/)?.[1];
      if (!token) return response({ error: "UNAUTHORIZED" }, 401);
      const reader = req.body?.getReader();
      if (!reader) return response({ error: "INVALID_REQUEST" }, 400);
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8192) {
          await reader.cancel();
          return response({ error: "BODY_TOO_LARGE" }, 413);
        }
        parts.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const binding = await store.binding();
      if (
        !binding?.active ||
        binding.project_ref !== project ||
        binding.public_key.kty !== "OKP" ||
        binding.public_key.crv !== "Ed25519" ||
        binding.public_key.d
      )
        return response({ error: "UNAUTHORIZED" }, 401);
      const { payload } = await jwtVerify(
        token,
        await importJWK(binding.public_key, "EdDSA"),
        {
          algorithms: ["EdDSA"],
          issuer: `urn:waypoint:runtime:${binding.org}`,
          audience,
          subject: binding.installation,
          maxTokenAge: "60s",
          clockTolerance: 0,
          requiredClaims: [
            "iat",
            "exp",
            "jti",
            "org",
            "project_ref",
            "grant_version",
            "body_hash",
          ],
        },
      );
      if (
        payload.org !== binding.org ||
        payload.project_ref !== project ||
        payload.grant_version !== binding.version ||
        payload.body_hash !== (await digest(text)) ||
        typeof payload.jti !== "string" ||
        !/^[a-f0-9-]{36}$/.test(payload.jti) ||
        !payload.exp ||
        !payload.iat ||
        payload.exp - payload.iat > 60
      )
        return response({ error: "UNAUTHORIZED" }, 401);
      const body = JSON.parse(text);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (k) => !["operation", "resource", "account"].includes(k),
        )
      )
        return response({ error: "INVALID_REQUEST" }, 400);
      if (!["discover", "records.read"].includes(body.operation))
        return response({ error: "CAPABILITY_DENIED" }, 403);
      if (body.operation === "discover" && Object.keys(body).length !== 1)
        return response({ error: "INVALID_REQUEST" }, 400);
      await store.consume(payload.jti, binding.installation, payload.exp);
      if (body.operation === "discover")
        return response({
          installation: binding.installation,
          org: binding.org,
          project_ref: project,
          version: binding.version,
          capabilities: ["records.read"],
          accounts: binding.accounts,
        });
      if (
        typeof body.resource !== "string" ||
        !/^[a-f0-9-]{36}$/.test(body.resource) ||
        !binding.accounts.includes(body.account)
      )
        return response({ error: "NOT_FOUND" }, 404);
      const record = await store.read(body.resource, body.account);
      if (!record || record.account_id !== body.account)
        return response({ error: "NOT_FOUND" }, 404);
      return response({ record });
    } catch {
      return response({ error: "UNAUTHORIZED_OR_UNAVAILABLE" }, 401);
    }
  };
}
