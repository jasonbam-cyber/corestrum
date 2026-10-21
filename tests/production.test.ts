import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { IdentityStore } from "../src/production/identity";
import { productionHandler } from "../src/production/gateway";
import type { IdentityProvider } from "../src/production/oidc";
import { CustomerRuntime } from "../src/production/customer";
import {
  bridgeHandler,
  bridgeEndpoint,
  digest,
  type Binding,
} from "../bridge/supabase/functions/waypoint-bridge/handler";
import { egressHandler } from "../src/production/egress";
import { hash } from "../src/production/common";

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  ACCOUNT = randomUUID(),
  FOREIGN = randomUUID(),
  RECORD = randomUUID();
const project = "aaaaaaaaaaaaaaaaaaaa",
  issuer = "https://id.example.test",
  origin = "https://portal.example.test";
const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "waypoint-prod-test-"));
  dirs.push(d);
  return d;
};
function identityStore() {
  const d = dir(),
    key = randomBytes(32),
    s = new IdentityStore(join(d, "identity.sqlite"), key);
  closers.push(() => s.close());
  return { s, d, key };
}
function enroll(s: IdentityStore, org = A, role: "owner" | "viewer" = "owner") {
  s.enroll(issuer, "subject-one", org, "Customer", role, true, "operator-test");
}
const identity = {
  issuer,
  subject: "subject-one",
  accessToken: "provider-secret-never-browser",
  expires: Date.now() + 3_600_000,
};
function fixture() {
  const { s, d } = identityStore();
  enroll(s);
  let active = true,
    completeCalls = 0;
  const provider: IdentityProvider = {
    async begin() {
      return {
        url: issuer + "/authorize?state=expected",
        transaction: {
          state: "expected",
          nonce: "nonce",
          verifier: "verifier",
        },
      };
    },
    async complete(url, t) {
      completeCalls++;
      if (url.searchParams.get("state") !== t.state) throw new Error("state");
      return identity;
    },
    async active() {
      return active;
    },
  };
  const calls: unknown[] = [];
  const handler = productionHandler({
    origin,
    identity: s,
    provider,
    async call(p, c, i) {
      calls.push({ p, c, i });
      return { ok: true };
    },
  });
  const req = (path: string, options: RequestInit = {}, peer = "192.0.2.1") =>
    handler(new Request(origin + path, options), peer);
  const session = s.create(identity);
  const headers = {
    origin,
    "content-type": "application/json",
    cookie: `__Host-wp_session=${session.id}`,
  };
  return {
    s,
    d,
    req,
    session,
    headers,
    calls,
    setActive: (v: boolean) => {
      active = v;
    },
    completeCalls: () => completeCalls,
  };
}
describe("production identity boundary", () => {
  test("unknown subjects, client supplied roles and unassigned organizations grant no access", async () => {
    const f = fixture();
    expect(() => f.s.create({ ...identity, subject: "unknown" })).toThrow(
      "MEMBERSHIP_REQUIRED",
    );
    expect(
      (
        await f.req("/api/demo-session", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ customer: B, role: "owner" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.req("/auth/customer", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ csrf: f.session.csrf, org: B }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.req("/auth/customer", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ csrf: f.session.csrf, org: A, role: "owner" }),
        })
      ).status,
    ).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
  test("session token and provider tokens are not stored as plaintext; wrong encryption key fails", () => {
    const { s, d } = identityStore();
    enroll(s);
    const token = s.create(identity);
    const rows = JSON.stringify(s.db.query("SELECT * FROM sessions").all());
    expect(rows).not.toContain(identity.accessToken);
    expect(rows).not.toContain(token.id);
    const wrong = new IdentityStore(
      join(d, "identity.sqlite"),
      randomBytes(32),
    );
    try {
      expect(() => wrong.session(token.id)).toThrow();
    } finally {
      wrong.close();
    }
  });
  test("local membership revocation, role change, idle expiry and upstream revocation terminate access", async () => {
    const f = fixture();
    f.s.select(f.session.id, A);
    f.s.enroll(
      issuer,
      "subject-one",
      A,
      "Customer",
      "viewer",
      true,
      "operator-test",
    );
    expect((await f.req("/api/session", { headers: f.headers })).status).toBe(
      401,
    );
    const next = f.s.create(identity);
    f.headers.cookie = `__Host-wp_session=${next.id}`;
    f.setActive(false);
    expect((await f.req("/api/session", { headers: f.headers })).status).toBe(
      401,
    );
    expect(() => f.s.session(next.id)).toThrow();
    const idle = f.s.create(identity);
    f.s.db.query("UPDATE sessions SET idle=0 WHERE id=?").run(hash(idle.id));
    expect(() => f.s.session(idle.id)).toThrow();
  });
  test("CSRF, hostile origin, forged customer and duplicate cookies are rejected", async () => {
    const f = fixture();
    f.s.select(f.session.id, A);
    for (const headers of [
      { ...f.headers, origin: "https://evil.test" },
      { ...f.headers, cookie: f.headers.cookie + "; " + f.headers.cookie },
      f.headers,
    ]) {
      expect(
        (
          await f.req("/onboarding/prepare", {
            method: "POST",
            headers,
            body: JSON.stringify({ csrf: "wrong", accounts: [ACCOUNT] }),
          })
        ).status,
      ).not.toBe(200);
    }
    expect(
      (
        await f.req("/onboarding/prepare", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({
            csrf: f.session.csrf,
            org: B,
            accounts: [ACCOUNT],
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.req("/onboarding/prepare", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ csrf: f.session.csrf, accounts: [ACCOUNT] }),
        })
      ).status,
    ).toBe(200);
    expect((f.calls[0] as any).p.org).toBe(A);
  });
  test("single-use login transaction, browser binding and secure cookie flags", async () => {
    const f = fixture();
    const start = await f.req("/auth/login");
    const cookie = start.headers.get("set-cookie")!;
    expect(cookie).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(
      (await f.req("/auth/callback?state=expected&code=code")).status,
    ).toBe(401);
    const callback = () =>
      f.req("/auth/callback?state=expected&code=code", {
        headers: { cookie: cookie.split(";")[0] },
      });
    const response = await callback();
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("__Host-wp_session=");
    expect(await response.text()).not.toContain(identity.accessToken);
    expect((await callback()).status).toBe(401);
    expect(f.completeCalls()).toBe(1);
  });
  test("wrong login state burns transaction and no session is created", async () => {
    const f = fixture(),
      start = await f.req("/auth/login");
    const response = await f.req("/auth/callback?state=wrong&code=code", {
      headers: { cookie: start.headers.get("set-cookie")!.split(";")[0] },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  test("logout destroys server session; portal has no demo selector, source scripts or browser token", async () => {
    const f = fixture();
    const html = await (await f.req("/", { headers: f.headers })).text();
    expect(html).not.toContain("demo-session");
    expect(html).not.toContain("<script");
    expect(html).not.toContain(identity.accessToken);
    const response = await f.req("/auth/logout", {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({ csrf: f.session.csrf }),
    });
    expect(response.status).toBe(303);
    expect(() => f.s.session(f.session.id)).toThrow();
  });
});

async function customerFixture() {
  const path = join(dir(), "customer.sqlite"),
    key = randomBytes(32);
  let binding: Binding | null = null,
    reads = 0;
  const used = new Set<string>();
  const handler = bridgeHandler(
    {
      async binding() {
        return binding;
      },
      async consume(nonce) {
        if (used.has(nonce)) throw new Error("replay");
        used.add(nonce);
      },
      async read(id, account) {
        reads++;
        return id === RECORD && account === ACCOUNT
          ? {
              id,
              account_id: account,
              title: "Approved issue",
              status: "open",
              version: 1,
            }
          : null;
      },
    },
    project,
  );
  const transport = async (body: string, token: string) =>
    handler(
      new Request(bridgeEndpoint(project), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body,
      }),
    );
  const runtime = new CustomerRuntime(A, path, key, project, transport);
  closers.push(() => runtime.close());
  const owner = { org: A, actor: hash("owner"), role: "owner" as const };
  const manifest = (await runtime.dispatch(owner, "prepare", {
    accounts: [ACCOUNT],
  })) as any;
  binding = { ...manifest, active: true };
  return {
    runtime,
    manifest,
    owner,
    path,
    key,
    transport,
    handler,
    binding: binding!,
    reads: () => reads,
  };
}
describe("customer runtime and Supabase bridge", () => {
  test("authenticated onboarding form reaches the bound runtime and bridge, then revokes access", async () => {
    const f = await customerFixture(),
      { s } = identityStore();
    enroll(s);
    const session = s.create(identity);
    s.select(session.id, A);
    const handler = productionHandler({
      origin,
      identity: s,
      provider: {
        async begin() {
          throw new Error("unused");
        },
        async complete() {
          throw new Error("unused");
        },
        async active() {
          return true;
        },
      },
      call: (p, c, i) => f.runtime.dispatch(p, c, i),
    });
    const response = await handler(
      new Request(origin + "/onboarding/verify", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
          cookie: `__Host-wp_session=${session.id}`,
        },
        body: new URLSearchParams({
          csrf: session.csrf,
          installation: f.manifest.installation,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`value="${f.manifest.installation}"`);
    expect(html).toContain("verified");
    const read = () =>
      handler(
        new Request(origin + "/onboarding/read", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            cookie: `__Host-wp_session=${session.id}`,
          },
          body: JSON.stringify({
            csrf: session.csrf,
            installation: f.manifest.installation,
            resource: RECORD,
            account: ACCOUNT,
          }),
        }),
      );
    expect((await read()).status).toBe(200);
    f.runtime.revoke(f.manifest.installation, f.owner.actor);
    expect((await read()).status).toBe(404);
  });
  test("revocation during an in-flight gateway read prevents delivering its contents", async () => {
    const { s } = identityStore();
    enroll(s);
    const session = s.create(identity);
    s.select(session.id, A);
    const handler = productionHandler({
      origin,
      identity: s,
      provider: {
        async begin() {
          throw new Error("unused");
        },
        async complete() {
          throw new Error("unused");
        },
        async active() {
          return true;
        },
      },
      async call() {
        s.enroll(
          issuer,
          "subject-one",
          A,
          "Customer",
          "owner",
          false,
          "test-operator",
        );
        return { private: "must-not-deliver" };
      },
    });
    const response = await handler(
      new Request(origin + "/", {
        headers: { cookie: `__Host-wp_session=${session.id}` },
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("must-not-deliver");
  });
  test("two databases and keys fail closed on wrong volume, caller or installation", async () => {
    const f = await customerFixture();
    expect(
      () => new CustomerRuntime(B, f.path, f.key, project, f.transport),
    ).toThrow("WRONG_CUSTOMER_VOLUME");
    const other = new CustomerRuntime(
      B,
      join(dir(), "customer.sqlite"),
      randomBytes(32),
      project,
      f.transport,
    );
    closers.push(() => other.close());
    await expect(
      other.dispatch({ ...f.owner, org: B }, "verify", {
        installation: f.manifest.installation,
      }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      f.runtime.dispatch({ ...f.owner, org: B }, "snapshot", {}),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      f.runtime.dispatch(f.owner, "prepare", { accounts: [ACCOUNT], org: B }),
    ).rejects.toThrow("INVALID_INPUT");
    expect(readFileSync(f.path).includes(Buffer.from("PRIVATE KEY"))).toBe(
      false,
    );
  });
  test("installation discovery then scoped read; private data is not persisted", async () => {
    const f = await customerFixture();
    await expect(
      f.runtime.dispatch(f.owner, "read", {
        installation: f.manifest.installation,
        resource: RECORD,
        account: ACCOUNT,
      }),
    ).rejects.toThrow("VERIFY_INSTALLATION_FIRST");
    expect(
      await f.runtime.dispatch(f.owner, "verify", {
        installation: f.manifest.installation,
      }),
    ).toMatchObject({ verified: true });
    expect(
      await f.runtime.dispatch(f.owner, "read", {
        installation: f.manifest.installation,
        resource: RECORD,
        account: ACCOUNT,
      }),
    ).toMatchObject({ record: { id: RECORD, title: "Approved issue" } });
    expect(JSON.stringify(f.runtime.snapshot())).not.toContain(
      "Approved issue",
    );
    expect(f.reads()).toBe(1);
  });
  test("viewer, out-of-scope account, unknown commands and revoked grants cannot read", async () => {
    const f = await customerFixture();
    await f.runtime.verify(f.manifest.installation, f.owner.actor);
    await expect(
      f.runtime.dispatch({ ...f.owner, role: "viewer" }, "verify", {
        installation: f.manifest.installation,
      }),
    ).rejects.toThrow("OWNER_REQUIRED");
    await expect(
      f.runtime.read(f.manifest.installation, RECORD, FOREIGN, f.owner.actor),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      f.runtime.dispatch(f.owner, "sql", { query: "select *" }),
    ).rejects.toThrow("CAPABILITY_DENIED");
    f.binding.active = false;
    await expect(
      f.runtime.read(f.manifest.installation, RECORD, ACCOUNT, f.owner.actor),
    ).rejects.toThrow("BRIDGE_REJECTED");
    f.binding.active = true;
    f.runtime.revoke(f.manifest.installation, f.owner.actor);
    await expect(
      f.runtime.verify(f.manifest.installation, f.owner.actor),
    ).rejects.toThrow("NOT_FOUND");
    expect(f.reads()).toBe(0);
  });
  test("grant rotation invalidates old signatures; reconnect creates a new key and installation", async () => {
    const f = await customerFixture();
    f.binding.version = 2;
    await expect(
      f.runtime.verify(f.manifest.installation, f.owner.actor),
    ).rejects.toThrow("BRIDGE_REJECTED");
    f.runtime.revoke(f.manifest.installation, f.owner.actor);
    const next = await f.runtime.prepare([ACCOUNT], f.owner.actor);
    expect(next.installation).not.toBe(f.manifest.installation);
    expect(next.public_key.x).not.toBe(f.manifest.public_key.x);
  });
  test("replay, mutated body, wrong project, wrong org, long lifetime and arbitrary capabilities rejected", async () => {
    const pair = await generateKeyPair("EdDSA"),
      id = randomUUID(),
      seen = new Set<string>();
    const binding: Binding = {
      installation: id,
      org: A,
      project_ref: project,
      version: 1,
      public_key: await exportJWK(pair.publicKey),
      active: true,
      accounts: [ACCOUNT],
    };
    const handler = bridgeHandler(
      {
        async binding() {
          return binding;
        },
        async consume(n) {
          if (seen.has(n)) throw new Error("replay");
          seen.add(n);
        },
        async read() {
          throw new Error("should not read");
        },
      },
      project,
    );
    const body = JSON.stringify({ operation: "discover" });
    const sign = async (
      overrides: Record<string, unknown> = {},
      ttl = "30s",
      signedBody = body,
    ) =>
      new SignJWT({
        org: A,
        project_ref: project,
        grant_version: 1,
        body_hash: await digest(signedBody),
        ...overrides,
      })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject(id)
        .setIssuer(`urn:waypoint:runtime:${A}`)
        .setAudience(bridgeEndpoint(project))
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime(ttl)
        .sign(pair.privateKey);
    const send = (token: string, data = body) =>
      handler(
        new Request(bridgeEndpoint(project), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: data,
        }),
      );
    const token = await sign();
    expect((await send(token)).status).toBe(200);
    expect((await send(token)).status).toBe(401);
    for (const override of [
      { org: B },
      { project_ref: "bbbbbbbbbbbbbbbbbbbb" },
      { grant_version: 2 },
      { body_hash: "bad" },
    ])
      expect((await send(await sign(override))).status).toBe(401);
    expect((await send(await sign({}, "120s"))).status).toBe(401);
    expect((await send(await sign({}, "-1s"))).status).toBe(401);
    const forbiddenBody = JSON.stringify({ operation: "sql" });
    expect(
      (await send(await sign({}, "30s", forbiddenBody), forbiddenBody)).status,
    ).toBe(403);
    expect(
      (await send(await sign(), JSON.stringify({ operation: "sql" }))).status,
    ).toBe(401);
    expect(
      (
        await handler(
          new Request(bridgeEndpoint(project), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        )
      ).status,
    ).toBe(401);
  });
  test("egress can only call the pinned project endpoint and never follow redirects", async () => {
    const requests: Array<[unknown, unknown]> = [];
    const handler = egressHandler(project, (async (url, options) => {
      requests.push([url, options]);
      return Response.json({ ok: true });
    }) as typeof fetch);
    expect(
      (
        await handler(
          new Request("http://egress:8080/https://evil.test", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(403);
    await handler(
      new Request("http://egress:8080/bridge", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer token",
          "x-target-url": "https://evil.test",
        },
        body: '{"operation":"discover"}',
      }),
    );
    expect(requests[0][0]).toBe(bridgeEndpoint(project));
    expect((requests[0][1] as RequestInit).redirect).toBe("error");
  });
});


test("anonymous floods cannot consume a valid subject budget or grow denial storage without bound", async () => {
  const f = fixture();
  const rows = () => (f.s.db.query("SELECT count(*) n FROM security_events").get() as { n: number }).n;
  const before = rows();
  for (let i = 0; i < 700; i++) {
    expect((await f.req("/health")).status).toBe(200);
    await f.req("/missing", { headers: { "x-forwarded-for": `198.51.100.${i % 255}` } }, "192.0.2.99");
    await f.req("/missing", { headers: { host: "attacker.invalid" } });
  }
  expect(rows() - before).toBeLessThanOrEqual(16);
  expect((await f.req("/missing", {}, "192.0.2.99")).status).toBe(429);
  expect((await f.req("/auth/login", {}, "192.0.2.2")).status).toBe(302);
  expect((await f.req("/api/session", { headers: f.headers }, "192.0.2.99")).status).toBe(200);
  expect((await f.req("/auth/logout", { method: "POST", headers: f.headers, body: JSON.stringify({ csrf: f.session.csrf }) }, "192.0.2.99")).status).toBe(303);
});
