import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localApp } from "../src/corestrum/local/server";

const password = "fictional-community-vault-passphrase";
const backupPassword = "fictional-community-backup-passphrase";
async function fixture(data = mkdtempSync(join(tmpdir(), "community-test-"))) {
  const origin = "http://127.0.0.1:4393";
  const app = localApp({ edition: "community", data, origin, assets: data });
  let cookie = "", csrf = "";
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => app.fetch(new Request(origin + "/api/local/" + route, { method: "POST", headers: { origin, "content-type": "application/json", cookie, "x-csrf-token": csrf, ...headers }, body: JSON.stringify(body) }));
  const state = async () => (await app.fetch(new Request(origin + "/api/local/state", { headers: { cookie } }))).json();
  const session = await post("session", { token: app.bootstrap });
  cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  csrf = (await session.json()).csrf;
  expect((await post("unlock", { password })).status).toBe(200);
  return { app, data, origin, post, state };
}

test("free community setup isolates businesses, requires local access protections, restores into an empty vault and persists identity", async () => {
  const originalFetch = globalThis.fetch;
  let egress = 0;
  globalThis.fetch = (() => { egress++; throw Error("UNEXPECTED_EGRESS"); }) as unknown as typeof fetch;
  const a = await fixture(), b = await fixture();
  let restarted: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const sa = await a.state(), sb = await b.state();
    expect(sa.license.plan).toBe("community");
    expect(sa.license.workspace).not.toBe(sb.license.workspace);
    expect((await a.app.fetch(new Request(a.origin + "/api/local/state"))).status).toBe(401);
    expect((await a.post("context", { context: "rejected" }, { origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await a.post("context", { context: "rejected" }, { "x-csrf-token": "wrong" })).status).toBe(403);
    for (const route of ["activation", "license", "license/refresh"])
      expect((await (await a.post(route, {})).json()).error).toBe("NOT_AVAILABLE_IN_COMMUNITY");
    expect((await a.post("context", { context: "Fictional Cedar SaaS workspace" })).status).toBe(200);
    expect((await b.state()).businessContext).toBe("");
    expect(readFileSync(join(a.data, "vault.enc"), "utf8")).not.toContain(sa.license.workspace);
    const saved = await a.post("automations", { template: "daily-brief", provider: "openai", instruction: "Review fictional supplied data only" });
    expect(saved.status).toBe(200);
    const exported = await a.post("backup/export", { password: backupPassword });
    expect(exported.status).toBe(200);
    const value = await exported.json();
    expect(JSON.stringify(value)).not.toContain("Fictional Cedar");
    const restoreBody = { password: backupPassword, archive: JSON.stringify(value), confirmed: true };
    expect((await b.post("backup/restore", { ...restoreBody, password: "wrong-fictional-backup-password" })).status).toBe(403);
    expect((await b.state()).businessContext).toBe("");
    const restored = await b.post("backup/restore", restoreBody);
    expect(restored.status).toBe(200);
    expect((await b.state()).businessContext).toBe("Fictional Cedar SaaS workspace");
    expect((await b.state()).license.workspace).toBe(sb.license.workspace);
    expect((await b.state()).operations.automations.every((x: any) => !x.enabled)).toBe(true);
    expect((await b.post("backup/restore", restoreBody)).status).toBe(403);
    await a.post("lock", {});
    expect((await a.state()).license).toBeNull();
    expect((await a.post("context", { context: "locked write" })).status).toBe(403);
    a.app.close();
    restarted = await fixture(a.data);
    expect((await restarted.state()).license.workspace).toBe(sa.license.workspace);
    expect((await restarted.state()).businessContext).toBe("Fictional Cedar SaaS workspace");
    expect(egress).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    if (restarted) restarted.app.close(); else a.app.close();
    b.app.close();
    rmSync(a.data, { recursive: true, force: true });
    rmSync(b.data, { recursive: true, force: true });
  }
});
