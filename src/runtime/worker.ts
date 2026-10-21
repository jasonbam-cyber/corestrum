import { chmodSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { CustomerRuntime } from "./store";
import { customers, Fault, type Org } from "../contracts";

if (
  process.env.PROTOTYPE_MODE !== "synthetic" ||
  process.env.NODE_ENV === "production"
)
  throw new Error("SYNTHETIC_ONLY");
const org = process.env.CUSTOMER_ORG as Org;
if (
  !Object.hasOwn(customers, org) ||
  !process.env.CUSTOMER_DB ||
  !process.env.RUNTIME_SOCKET ||
  !process.env.RUNTIME_TOKEN
)
  throw new Error("INVALID_RUNTIME_BINDING");
process.umask(0o077);
const runtime = new CustomerRuntime(org, process.env.CUSTOMER_DB);
const expected = Buffer.from(`Bearer ${process.env.RUNTIME_TOKEN}`);
const server = Bun.serve({
  unix: process.env.RUNTIME_SOCKET,
  maxRequestBodySize: 16384,
  async fetch(req) {
    const token = Buffer.from(req.headers.get("authorization") ?? "");
    if (token.length !== expected.length || !timingSafeEqual(token, expected))
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    if (req.method !== "POST" || new URL(req.url).pathname !== "/command")
      return new Response(null, { status: 404 });
    try {
      const body = await req.json();
      if (
        !body.principal ||
        !body.input ||
        typeof body.input !== "object" ||
        Array.isArray(body.input)
      )
        throw new Fault("INVALID_INPUT", 400);
      return Response.json(
        runtime.dispatch(body.principal, body.command, body.input),
      );
    } catch (e) {
      return Response.json(
        { error: e instanceof Fault ? e.code : "RUNTIME_UNAVAILABLE" },
        { status: e instanceof Fault ? e.status : 503 },
      );
    }
  },
});
chmodSync(process.env.RUNTIME_SOCKET, 0o600);
const stop = () => {
  server.stop(true);
  runtime.close();
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
// Parent death closes the private heartbeat pipe; never leave orphan customer runtimes.
process.stdin.resume();
process.stdin.once("end", stop);
