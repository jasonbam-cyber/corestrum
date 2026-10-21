import { chmodSync, readFileSync } from "node:fs";
import { CustomerRuntime } from "./customer";
import { Denied, equal, fields, secretFile, uuid } from "./common";
import type { Principal } from "./identity";

const config = JSON.parse(
  readFileSync(process.env.CUSTOMER_CONFIG_FILE!, "utf8"),
);
fields(config, [
  "org",
  "project",
  "database",
  "keyFile",
  "tokenFile",
  "socket",
  "proxy",
]);
if (
  !uuid(config.org) ||
  config.database !== "/data/customer.sqlite" ||
  config.socket !== "/run/runtime/worker.sock" ||
  config.proxy !== "http://egress:8080/bridge" ||
  process.env.PROTOTYPE_MODE
)
  throw new Error("DEDICATED_CUSTOMER_CONFIGURATION_REQUIRED");
const token = secretFile(String(config.tokenFile)).toString().trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("INVALID_RUNTIME_TOKEN");
const runtime = new CustomerRuntime(
  config.org,
  config.database,
  secretFile(String(config.keyFile)),
  String(config.project),
  async (body, authorization) =>
    fetch(String(config.proxy), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authorization}`,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    }),
);
process.umask(0o007);
const server = Bun.serve({
  unix: config.socket,
  maxRequestBodySize: 8192,
  async fetch(req) {
    try {
      if (
        req.method !== "POST" ||
        new URL(req.url).pathname !== "/command" ||
        !equal(req.headers.get("authorization") ?? "", `Bearer ${token}`)
      )
        throw new Denied("UNAUTHORIZED", 401);
      const body = await req.json();
      fields(body, ["principal", "command", "input"]);
      fields(body.principal, ["org", "actor", "role"]);
      return Response.json(
        await runtime.dispatch(
          body.principal as Principal,
          String(body.command),
          body.input,
        ),
      );
    } catch (e) {
      return Response.json(
        { error: e instanceof Denied ? e.code : "RUNTIME_UNAVAILABLE" },
        { status: e instanceof Denied ? e.status : 503 },
      );
    }
  },
});
chmodSync(config.socket, 0o660);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.stop(true);
    runtime.close();
    process.exit(0);
  });
