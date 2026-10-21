/** Isolated visual QA only. Ephemeral test signer, synthetic company, no provider keys. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import { localApp } from "../src/corestrum/local/server";
import { signLicense } from "../src/corestrum/license";
import { GET, POST } from "../api/corestrum";
const data = mkdtempSync(join(tmpdir(), "corestrum-visual-"));
const origin = "http://127.0.0.1:4395",
  keys = await generateKeyPair("EdDSA", { extractable: true });
const app = localApp({
  data,
  origin,
  cloudOrigin: "https://corestrum-staging.example",
  environment: "staging",
  licensePublicKey: await exportJWK(keys.publicKey),
  assets: resolve("dist-corestrum"),
});
let cookie = "",
  csrf = "";
const post = async (path: string, body: unknown) =>
  app.fetch(
    new Request(origin + path, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify(body),
    }),
  );
const session = await post("/api/local/session", { token: app.bootstrap });
cookie = session.headers.get("set-cookie")!.split(";")[0]!;
csrf = (await session.json()).csrf;
await post("/api/local/unlock", { password: randomUUID() + randomUUID() });
const activation = await (await post("/api/local/activation", {})).json(),
  now = Math.floor(Date.now() / 1000),
  workspace = randomUUID();
const token = await signLicense(
  {
    id: workspace,
    workspace,
    device: activation.device,
    plan: "monthly",
    major: 1,
    issued: now,
    expires: now + 3600,
    updatesUntil: now + 3600,
    environment: "staging",
  },
  await exportJWK(keys.privateKey),
  "ephemeral-visual-test",
);
await post("/api/local/license", { license: token });
await post("/api/local/context", {
  context:
    "FICTIONAL PILOT: Cedar Mobile Notary. We need reliable bookings, a daily exception report, and a weekly review of supplied income and expenses. No real clients, bank feeds, booking systems, or advertising accounts are connected.",
});
await post("/api/local/automations", {
  template: "daily-brief",
  provider: "openai",
  instruction: "Review supplied booking summaries.",
});
const local = Bun.serve({
  hostname: "127.0.0.1",
  port: 4395,
  fetch(req) {
    if (new URL(req.url).pathname === "/qa-start")
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": cookie + "; HttpOnly; SameSite=Strict; Path=/",
        },
      });
    return app.fetch(req);
  },
});
const cloud = Bun.serve({
  hostname: "127.0.0.1",
  port: 4394,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/"))
      return req.method === "POST" ? POST(req) : GET(req);
    const path = u.pathname.startsWith("/assets/")
      ? resolve("dist-corestrum", "." + u.pathname)
      : resolve("dist-corestrum/index.html");
    if (!path.startsWith(resolve("dist-corestrum") + "/"))
      return new Response(null, { status: 404 });
    return new Response(Bun.file(path));
  },
});
const close = () => {
  local.stop();
  cloud.stop();
  app.close();
  rmSync(data, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
console.log(
  "Synthetic website: http://127.0.0.1:4394/ — Synthetic local workspace: http://127.0.0.1:4395/qa-start — no customer credentials or provider requests.",
);
