import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startGateway } from "../src/gateway";
let app: Awaited<ReturnType<typeof startGateway>>;
let root: string;
type Session = { cookie: string; csrf: string };
async function login(org: string, role = "owner"): Promise<Session> {
  const response = await fetch(`${app.origin}/api/demo-session`, {
    method: "POST",
    headers: { origin: app.origin, "content-type": "application/json" },
    body: JSON.stringify({ customer: org, role }),
  });
  expect(response.status).toBe(200);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0],
    csrf: ((await response.json()) as { csrf: string }).csrf,
  };
}
async function command(
  s: Session,
  command: string,
  input: Record<string, unknown>,
) {
  return fetch(`${app.origin}/api/command`, {
    method: "POST",
    headers: {
      origin: app.origin,
      "content-type": "application/json",
      cookie: s.cookie,
      "x-csrf-token": s.csrf,
    },
    body: JSON.stringify({ command, input }),
  });
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ops-gateway-"));
  app = await startGateway({ root, port: 0, mode: "synthetic" });
});
afterAll(async () => {
  await app?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});
test("two live worker PIDs and private per-customer databases", () => {
  expect(app.pids.cedar).not.toBe(app.pids.mesa);
  expect(app.pids.cedar).not.toBe(process.pid);
  expect(statSync(join(root, "cedar/runtime.sqlite")).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "mesa/runtime.sqlite")).mode & 0o777).toBe(0o600);
});
test("anonymous, foreign origins, spoofed Host and missing CSRF fail closed", async () => {
  expect((await fetch(`${app.origin}/api/snapshot`)).status).toBe(401);
  expect(
    (
      await fetch(`${app.origin}/api/health`, {
        headers: { origin: "https://evil.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${app.origin}/api/health`, {
        headers: { host: "evil.invalid" },
      })
    ).status,
  ).toBe(403);
  const s = await login("cedar");
  expect(
    (
      await fetch(`${app.origin}/api/command`, {
        method: "POST",
        headers: {
          origin: app.origin,
          cookie: s.cookie,
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
  ).toBe(403);
});
test("session cookie is HttpOnly and SameSite Strict; security headers lock external sources", async () => {
  const r = await fetch(`${app.origin}/api/demo-session`, {
    method: "POST",
    headers: { origin: app.origin, "content-type": "application/json" },
    body: JSON.stringify({ customer: "cedar", role: "owner" }),
  });
  expect(r.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  expect(r.headers.get("content-security-policy")).toContain(
    "connect-src 'self'",
  );
  expect(r.headers.get("cache-control")).toBe("no-store");
});
test("authenticated routing rejects caller tenant fields and cross-customer action IDs", async () => {
  const a = await login("cedar"),
    b = await login("mesa");
  expect(
    (
      await command(a, "start", {
        issueId: "cedar-issue-alpha",
        key: "tamper",
        org: "mesa",
      })
    ).status,
  ).toBe(400);
  const response = await command(a, "start", {
    issueId: "cedar-issue-alpha",
    key: "normal",
  });
  expect(response.status).toBe(200);
  const run = (await response.json()) as { id: string; intent_hash: string };
  expect(
    (await command(b, "approve", { id: run.id, hash: run.intent_hash })).status,
  ).toBe(404);
  const bExport = await fetch(`${app.origin}/api/audit-export`, {
    headers: { cookie: b.cookie },
  });
  expect(await bExport.text()).not.toContain(run.id);
});
test("switching demo customer revokes the old session", async () => {
  const a = await login("cedar");
  const response = await fetch(`${app.origin}/api/demo-session`, {
    method: "POST",
    headers: {
      origin: app.origin,
      cookie: a.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ customer: "mesa", role: "owner" }),
  });
  expect(response.status).toBe(200);
  expect(
    (
      await fetch(`${app.origin}/api/snapshot`, {
        headers: { cookie: a.cookie },
      })
    ).status,
  ).toBe(401);
});
test("read-only role cannot change permissions or spending", async () => {
  const viewer = await login("cedar", "viewer");
  expect((await command(viewer, "connection", { active: false })).status).toBe(
    403,
  );
  expect(
    (await command(viewer, "budget", { limit: 10000000, funding: "managed" }))
      .status,
  ).toBe(403);
});
test("private filesystem and database paths cannot be served", async () => {
  for (const path of [
    "/.data/cedar/runtime.sqlite",
    "/src/server.ts",
    "/assets/../../package.json",
  ])
    expect((await fetch(`${app.origin}${path}`)).status).toBe(404);
});
test("production mode and duplicate supervisor cannot start", async () => {
  expect(startGateway({ root, port: 0, mode: "production" })).rejects.toThrow(
    "SYNTHETIC_ONLY",
  );
  expect(startGateway({ root, port: 0, mode: "synthetic" })).rejects.toThrow();
});
