import { bridgeEndpoint } from "../../bridge/supabase/functions/waypoint-bridge/handler";

export function egressHandler(
  project: string,
  transport: typeof fetch = fetch,
) {
  const endpoint = bridgeEndpoint(project);
  return async (req: Request) => {
    if (
      req.method !== "POST" ||
      new URL(req.url).pathname !== "/bridge" ||
      req.headers.get("content-type") !== "application/json"
    )
      return new Response(null, { status: 403 });
    const body = await req.text(),
      token = req.headers.get("authorization") ?? "";
    if (
      Buffer.byteLength(body) > 8192 ||
      token.length > 8192 ||
      !token.startsWith("Bearer ")
    )
      return new Response(null, { status: 400 });
    try {
      const upstream = await transport(endpoint, {
        method: "POST",
        body,
        headers: { authorization: token, "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const reader = upstream.body?.getReader();
      if (!reader) return new Response(null, { status: 502 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 32768) {
          await reader.cancel();
          return new Response(null, { status: 502 });
        }
        chunks.push(value);
      }
      return new Response(Buffer.concat(chunks), {
        status: upstream.status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    } catch {
      return new Response(null, { status: 502 });
    }
  };
}
if (import.meta.main)
  Bun.serve({
    hostname: "0.0.0.0",
    port: 8080,
    maxRequestBodySize: 8192,
    fetch: egressHandler(process.env.CUSTOMER_PROJECT_REF!),
  });
