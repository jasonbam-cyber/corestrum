import { readFileSync } from "node:fs";
import { IdentityStore } from "./identity";
import { productionHandler } from "./gateway";
import { oidcProvider } from "./oidc";
import { Denied, fields, httpsOrigin, secretFile, uuid } from "./common";

type Registry = Record<string, { socket: string; tokenFile: string }>;
const config = JSON.parse(
  readFileSync(process.env.PRODUCTION_CONFIG_FILE!, "utf8"),
);
fields(config, [
  "origin",
  "database",
  "sessionKeyFile",
  "tlsCertFile",
  "tlsKeyFile",
  "issuer",
  "clientId",
  "clientSecretFile",
  "requiredAcr",
  "registryFile",
  "port",
]);
httpsOrigin(String(config.origin));
if (
  process.env.PROTOTYPE_MODE ||
  !Number.isInteger(config.port) ||
  [3040, 4381, 7474].includes(Number(config.port))
)
  throw new Error("DEDICATED_PRODUCTION_CONFIGURATION_REQUIRED");
const registry = JSON.parse(
  readFileSync(String(config.registryFile), "utf8"),
) as Registry;
for (const [org, r] of Object.entries(registry)) {
  if (!uuid(org) || r.socket !== `/run/customers/${org}/worker.sock`)
    throw new Error("INVALID_RUNTIME_REGISTRY");
}
const store = new IdentityStore(
  String(config.database),
  secretFile(String(config.sessionKeyFile)),
);
const provider = await oidcProvider({
  origin: String(config.origin),
  issuer: String(config.issuer),
  clientId: String(config.clientId),
  clientSecret: secretFile(String(config.clientSecretFile)).toString().trim(),
  requiredAcr: String(config.requiredAcr),
});
const handler = productionHandler({
  origin: String(config.origin),
  identity: store,
  provider,
  async call(principal, command, input) {
    const runtime = registry[principal.org];
    if (!runtime) throw new Denied("CUSTOMER_RUNTIME_UNAVAILABLE", 503);
    const response = await fetch("http://runtime/command", {
      unix: runtime.socket,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secretFile(runtime.tokenFile).toString().trim()}`,
      },
      body: JSON.stringify({ principal, command, input }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 65536)
      throw new Denied("INVALID_RUNTIME_RESPONSE", 502);
    if (!response.ok)
      throw new Denied("RUNTIME_REQUEST_DENIED", response.status);
    return JSON.parse(text);
  },
});
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(config.port),
  maxRequestBodySize: 8192,
  tls: {
    cert: readFileSync(String(config.tlsCertFile)),
    key: secretFile(String(config.tlsKeyFile)),
  },
  fetch: (request, server) => handler(request, server.requestIP(request)?.address),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.stop(true);
    store.close();
    process.exit(0);
  });
console.log(
  "Production authentication gateway listening; live-customer release gates remain required.",
);
