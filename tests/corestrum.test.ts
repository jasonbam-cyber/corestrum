import { test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { LocalVault } from "../src/corestrum/local/vault";
import { Operations } from "../src/corestrum/local/operations";
import {
  saveProvider,
  providerSnapshot,
  draft,
  type Draft,
} from "../src/corestrum/local/ai";
import {
  signLicense,
  verifyLicense,
  type License,
} from "../src/corestrum/license";
import { fingerprint, checkDeviceProof } from "../src/corestrum/device";
import { localApp } from "../src/corestrum/local/server";
import { hasFreshSecondFactor } from "../src/corestrum/cloud/auth";
import { readBody } from "../src/corestrum/http";

const paths: string[] = [];
const cleanup: (() => void)[] = [];
const dir = () => {
  const p = mkdtempSync(join(tmpdir(), "corestrum-test-"));
  paths.push(p);
  return p;
};
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true });
});
const password = "fictional-passphrase-for-tests";
const fakeKey = "fixture-customer-credential-only";
const response: Draft = {
  text: "Supplied evidence is incomplete. Ask owner for totals.",
  provider: "openai",
  model: "fixture-model",
  inputTokens: 10,
  outputTokens: 15,
};
const mockFetch = (fn: (input: any, init: any) => Promise<Response>) =>
  fn as typeof fetch;
async function vault(now = Date.now) {
  const v = new LocalVault(join(dir(), "vault.enc"), now);
  await v.unlock(password);
  return v;
}
async function signing() {
  const k = await generateKeyPair("EdDSA", { extractable: true });
  return {
    privateKey: await exportJWK(k.privateKey),
    publicKey: await exportJWK(k.publicKey),
  };
}
type PaidLicense = Exclude<License, { plan: "complimentary" }>;
const license = (device: string, extra: Partial<PaidLicense> = {}): PaidLicense => ({
  id: randomUUID(),
  workspace: randomUUID(),
  device,
  plan: "monthly",
  major: 1,
  issued: Math.floor(Date.now() / 1000),
  expires: Math.floor(Date.now() / 1000) + 86400,
  updatesUntil: Math.floor(Date.now() / 1000) + 86400,
  environment: "staging",
  ...extra,
});

test("vault encrypts credentials, rejects wrong passphrase, locks after idle and enforces record binding", async () => {
  let now = 1000;
  const v = await vault(() => now);
  v.set("credential", fakeKey);
  const sealed = v.seal("private report", "report:one");
  expect(readFileSync(v.path, "utf8")).not.toContain(fakeKey);
  expect(() => v.unseal(sealed, "report:two")).toThrow();
  v.lock();
  expect(() => v.get("credential")).toThrow("VAULT_LOCKED");
  await expect(v.unlock("wrong-but-long-passphrase")).rejects.toThrow(
    "VAULT_UNLOCK_FAILED",
  );
  await v.unlock(password);
  expect(v.get("credential")).toBe(fakeKey);
  now += 15 * 60000 + 1;
  expect(v.unlocked).toBe(false);
});
test("vault refuses public file permissions and symlinks", async () => {
  const v = await vault();
  v.lock();
  chmodSync(v.path, 0o644);
  await expect(v.unlock(password)).rejects.toThrow("UNSAFE_VAULT_FILE");
  chmodSync(v.path, 0o600);
  const other = new LocalVault(join(dir(), "link"));
  symlinkSync(v.path, other.path);
  await expect(other.unlock(password)).rejects.toThrow("UNSAFE_VAULT_FILE");
});
test("license is bound to device, environment, signature, version and expiration", async () => {
  const k = await signing(),
    l = license("device-a"),
    token = await signLicense(l, k.privateKey, "test");
  const expected = {
    device: "device-a",
    environment: "staging" as const,
    major: 1,
  };
  expect((await verifyLicense(token, k.publicKey, expected)).workspace).toBe(
    l.workspace,
  );
  for (const change of [
    { device: "device-b" },
    { environment: "production" as const },
    { major: 2 },
  ])
    await expect(
      verifyLicense(token, k.publicKey, { ...expected, ...change }),
    ).rejects.toThrow();
  await expect(
    verifyLicense(token, (await signing()).publicKey, expected),
  ).rejects.toThrow();
  await expect(
    verifyLicense(token, k.publicKey, expected, l.expires! + 1),
  ).rejects.toThrow();
  await expect(
    verifyLicense(
      await signLicense(
        { ...l, expires: l.issued + 8 * 86400 },
        k.privateKey,
        "test",
      ),
      k.publicKey,
      expected,
    ),
  ).rejects.toThrow();
});
test("perpetual license keeps its major version after update entitlement expires", async () => {
  const k = await signing(),
    l = license("device", { plan: "perpetual", expires: null });
  const token = await signLicense(l, k.privateKey, "test");
  expect(
    (
      await verifyLicense(
        token,
        k.publicKey,
        { device: "device", environment: "staging", major: 1 },
        l.issued + 400 * 86400,
      )
    ).plan,
  ).toBe("perpetual");
});
test("device proof cannot move to another device, endpoint or time", async () => {
  const k = await generateKeyPair("EdDSA", { extractable: true }),
    pub = await exportJWK(k.publicKey),
    d = fingerprint(pub),
    jti = randomUUID();
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: "corestrum-device+jwt" })
    .setSubject(d)
    .setAudience("https://staging.example/api/license/activate")
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(k.privateKey);
  expect(
    await checkDeviceProof(
      token,
      pub,
      d,
      "https://staging.example/api/license/activate",
    ),
  ).toBe(jti);
  await expect(
    checkDeviceProof(
      token,
      pub,
      d,
      "https://staging.example/api/license/refresh",
    ),
  ).rejects.toThrow();
  await expect(
    checkDeviceProof(
      token,
      pub,
      "other",
      "https://staging.example/api/license/activate",
    ),
  ).rejects.toThrow();
  await expect(
    checkDeviceProof(
      token,
      pub,
      d,
      "https://staging.example/api/license/activate",
      Date.now() + 65000,
    ),
  ).rejects.toThrow();
});
test("MFA never treats absent second factor as sufficient", () => {
  for (const v of [
    undefined,
    null,
    [-1, -1],
    [0, -1],
    [10, 0],
    [0, 10],
    ["0", 0],
  ])
    expect(hasFreshSecondFactor(v)).toBe(false);
  expect(hasFreshSecondFactor([0, 0])).toBe(true);
});
test("streaming input stops at byte limit without trusting Content-Length", async () => {
  await expect(readBody(new Response("é".repeat(100)), 100)).rejects.toThrow(
    "BODY_TOO_LARGE",
  );
});
test("BYOK validation only reaches selected provider and never returns a credential", async () => {
  const v = await vault();
  let calls = 0;
  const result = await saveProvider(
    v,
    "openai",
    fakeKey,
    "fixture-model",
    mockFetch(async (url, init) => {
      calls++;
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(init.headers.authorization).toBe("Bearer " + fakeKey);
      expect(init.redirect).toBe("error");
      expect(init.body).toBeUndefined();
      return Response.json({ data: [{ id: "fixture-model" }] });
    }),
  );
  expect(calls).toBe(1);
  expect(JSON.stringify([result, providerSnapshot(v)])).not.toContain(fakeKey);
});
test("AI has no platform key fallback, no tools, and redacts provider credential echoes", async () => {
  const v = await vault();
  let calls = 0;
  const transport = mockFetch(async (url, init) => {
    calls++;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    expect(body.tools).toBeUndefined();
    expect(body.store).toBe(false);
    expect(body.instructions).toContain("cannot spend money");
    return Response.json({
      output: [
        { type: "message", content: [{ type: "output_text", text: fakeKey }] },
      ],
      usage: { input_tokens: 12, output_tokens: 4 },
    });
  });
  await expect(
    draft(v, "openai", "operations", "Help grow", "Notary business", transport),
  ).rejects.toThrow("CUSTOMER_AI_REQUIRED");
  expect(calls).toBe(0);
  v.set(
    "provider:openai",
    JSON.stringify({ key: fakeKey, model: "fixture-model" }),
  );
  const d = await draft(
    v,
    "openai",
    "operations",
    "Help grow",
    "Notary business",
    transport,
  );
  expect(d.text).toBe("[credential removed]");
  expect(d.inputTokens).toBe(12);
});
test("provider disconnect fences an in-flight result", async () => {
  const v = await vault();
  v.set(
    "provider:anthropic",
    JSON.stringify({ key: fakeKey, model: "fixture-model" }),
  );
  await expect(
    draft(
      v,
      "anthropic",
      "bookkeeping",
      "Review",
      "Supplied totals",
      mockFetch(async () => {
        v.remove("provider:anthropic");
        return Response.json({
          content: [{ type: "text", text: "private result" }],
        });
      }),
    ),
  ).rejects.toThrow("PROVIDER_CHANGED");
});
test("provider failures and oversized responses do not expose error bodies", async () => {
  const v = await vault();
  await expect(
    saveProvider(
      v,
      "openai",
      fakeKey,
      "fixture-model",
      mockFetch(async () => new Response(fakeKey, { status: 401 })),
    ),
  ).rejects.toThrow("PROVIDER_CREDENTIAL_REJECTED");
  expect(v.has("provider:openai")).toBe(false);
  await expect(
    saveProvider(
      v,
      "openai",
      fakeKey,
      "fixture-model",
      mockFetch(async () => new Response("x".repeat(512001))),
    ),
  ).rejects.toThrow("PROVIDER_RESPONSE_TOO_LARGE");
});
test("Operations Lead obtains separate specialist drafts and records contribution links", async () => {
  const v = await vault(),
    roles: string[] = [];
  let finalContext = "";
  const o = new Operations(
    join(dir(), "operations.sqlite"),
    randomUUID(),
    v,
    async () => {},
    async (_v, _p, role, _prompt, context) => {
      roles.push(role);
      finalContext = context;
      return { ...response, text: role + " draft" };
    },
  );
  cleanup.push(() => o.db.close());
  const r = await o.run(
    "operations",
    "openai",
    "Review my business",
    undefined,
    ["bookkeeping", "marketing", "support"],
  );
  expect(roles).toEqual(["bookkeeping", "marketing", "support", "operations"]);
  expect(finalContext).toContain("bookkeeping draft");
  expect(r.draft.contributions).toHaveLength(3);
  expect(o.verifyLedger()).toBe(true);
  expect(o.snapshot().reports).toHaveLength(4);
  expect(readFileSync(o.db.filename)).not.toContain("bookkeeping draft");
  expect(() => o.db.exec("DELETE FROM ledger")).toThrow();
});
test("automations start paused, run once when due and do not retry uncertain requests", async () => {
  const v = await vault();
  let calls = 0,
    now = 1000;
  const o = new Operations(
    join(dir(), "operations.sqlite"),
    randomUUID(),
    v,
    async () => {},
    async () => {
      calls++;
      throw Error("PROVIDER_UNAVAILABLE");
    },
    () => now,
  );
  cleanup.push(() => o.db.close());
  const a = await o.create({
    template: "support-review",
    provider: "openai",
    instruction: "Review bookings",
  });
  await o.tick();
  expect(calls).toBe(0);
  await o.toggle(a.id, true);
  await expect(o.tick()).rejects.toThrow("PROVIDER_UNAVAILABLE");
  await o.tick();
  expect(calls).toBe(1);
  expect((o.snapshot().reports[0] as any).state).toBe("needs_review");
});
test("pausing a routine during a request prevents accepting or continuing its work", async () => {
  const v = await vault();
  let calls = 0,
    id = "";
  const o = new Operations(
    join(dir(), "operations.sqlite"),
    randomUUID(),
    v,
    async () => {},
    async () => {
      calls++;
      await o.toggle(id, false);
      return { ...response };
    },
  );
  cleanup.push(() => o.db.close());
  id = (await o.create({ template: "daily-brief", provider: "openai" })).id;
  await o.toggle(id, true);
  await expect(o.tick()).rejects.toThrow("AUTOMATION_CHANGED");
  expect(calls).toBe(1);
  expect((o.snapshot().reports[0] as any).state).toBe("needs_review");
});
test("each specialist request consumes the daily allowance and competing runs are denied", async () => {
  const v = await vault();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (release = r));
  const o = new Operations(
    join(dir(), "operations.sqlite"),
    randomUUID(),
    v,
    async () => {},
    async () => {
      started();
      await gate;
      return { ...response };
    },
  );
  cleanup.push(() => o.db.close());
  const pending = o.run("operations", "openai", "review");
  await ready;
  await expect(o.run("support", "openai", "reply")).rejects.toThrow(
    "RUN_IN_PROGRESS",
  );
  release();
  await pending;
  for (let i = 0; i < 19; i++) await o.run("support", "openai", "reply");
  await expect(o.run("support", "openai", "reply")).rejects.toThrow(
    "DAILY_AI_RUN_LIMIT",
  );
});
test("local operations volume cannot be opened as another customer", async () => {
  const v = await vault(),
    path = join(dir(), "operations.sqlite"),
    o = new Operations(path, randomUUID(), v, async () => {});
  o.db.close();
  expect(() => new Operations(path, randomUUID(), v, async () => {})).toThrow(
    "WRONG_CUSTOMER_VOLUME",
  );
});
test("local onboarding enforces launch secret, origin, CSRF, license and workspace binding", async () => {
  const keys = await signing(),
    origin = "http://127.0.0.1:4393";
  const app = localApp({
    data: dir(),
    origin,
    cloudOrigin: "https://staging.example",
    licensePublicKey: keys.publicKey,
    environment: "staging",
    assets: dir(),
  });
  cleanup.push(() => app.close());
  const send = (path: string, body: any, extras: Record<string, string> = {}) =>
    app.fetch(
      new Request(origin + path, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...extras },
        body: JSON.stringify(body),
      }),
    );
  expect(
    (await app.fetch(new Request(origin + "/api/local/state"))).status,
  ).toBe(401);
  expect(
    (
      await send(
        "/api/local/session",
        { token: app.bootstrap },
        { origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  const start = await send("/api/local/session", { token: app.bootstrap });
  expect(start.status).toBe(200);
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!,
    { csrf } = await start.json(),
    headers = { cookie, "x-csrf-token": csrf };
  expect(
    (await send("/api/local/session", { token: app.bootstrap })).status,
  ).toBe(403);
  expect(
    (await send("/api/local/unlock", { password }, { cookie })).status,
  ).toBe(403);
  expect((await send("/api/local/unlock", { password }, headers)).status).toBe(
    200,
  );
  expect(
    (
      await send(
        "/api/local/draft",
        { agent: "operations", provider: "openai", prompt: "Run" },
        headers,
      )
    ).status,
  ).toBe(403);
  for (const path of ["status", "setup", "connect", "cancel"]) {
    const held = await send("/api/local/claude/" + path, {}, headers);
    expect(held.status).toBe(403);
    expect(await held.json()).toEqual({ error: "LICENSE_REQUIRED" });
    expect((await send("/api/local/claude/" + path, {}, { cookie })).status).toBe(403);
  }
  for (const action of ["export", "restore"]) {
    const held = await send("/api/local/backup/" + action, {}, headers);
    expect(await held.json()).toEqual({ error: "LICENSE_REQUIRED" });
    expect((await send("/api/local/backup/" + action, {}, { cookie })).status).toBe(403);
  }
  const device = await (
    await send("/api/local/activation", {}, headers)
  ).json();
  const l = license(device.device),
    token = await signLicense(l, keys.privateKey, "test");
  expect(
    (await send("/api/local/license", { license: token }, headers)).status,
  ).toBe(200);
  expect(
    (
      await send(
        "/api/local/context",
        { context: "Fictional mobile notary business" },
        headers,
      )
    ).status,
  ).toBe(200);
  await send("/api/local/lock", {}, headers);
  await send("/api/local/unlock", { password }, headers);
  const other = await signLicense(
    license(device.device),
    keys.privateKey,
    "test",
  );
  expect(
    (
      await (
        await send("/api/local/license", { license: other }, headers)
      ).json()
    ).error,
  ).toBe("WORKSPACE_MISMATCH");
});
