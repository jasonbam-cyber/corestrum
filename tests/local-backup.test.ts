import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalVault } from "../src/corestrum/local/vault";
import { Operations } from "../src/corestrum/local/operations";
import { decryptBackup, encryptBackup } from "../src/corestrum/local/backup";
const roots: string[] = [], databases: Operations[] = [];
afterEach(() => { for (const op of databases.splice(0)) try { op.db.close(); } catch {} roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })); });
const password = "fictional backup password only";
async function instance(workspace = randomUUID()) {
  const root = mkdtempSync(join(tmpdir(), "corestrum-recovery-")); roots.push(root);
  const vault = new LocalVault(join(root, "vault.enc")); await vault.unlock("fictional local password only");
  const op = new Operations(join(root, "operations.sqlite"), workspace, vault, async () => {}, async (_, p) => ({ provider: p, model: "fixture-model", text: "Fictional report based on supplied totals only", inputTokens: 2, outputTokens: 5 })); databases.push(op);
  return { root, vault, op, workspace };
}

test("encrypted data-only restore reseals a first report on a new device and preserves audit lineage, with routines paused", async () => {
  const a = await instance();
  a.vault.set("device-private", "DO_NOT_BACK_UP_DEVICE"); a.vault.set("license", "DO_NOT_BACK_UP_LICENSE");
  a.vault.set("provider:openai", "DO_NOT_BACK_UP_API"); a.vault.set("claude-profile", "DO_NOT_BACK_UP_CLAUDE"); a.vault.set("supabase-project", "DO_NOT_BACK_UP_BRIDGE");
  a.op.saveContext("Fictional notary A: owner supplied totals");
  const routine = await a.op.create({ template: "custom-workflow", provider: "openai", name: "Weekly owner review", hours: 24, instruction: "Review fictional supplied totals" });
  await a.op.toggle(routine.id, true);
  const report = await a.op.run("operations", "openai", "First fictional business report");
  const data = a.op.exportBusiness(); const raw = JSON.stringify(data);
  expect(raw).not.toContain("DO_NOT_BACK_UP");
  const encrypted = await encryptBackup(data, password), archive = JSON.stringify(encrypted);
  expect(archive).not.toContain("Fictional"); expect(archive).not.toContain(a.workspace);
  const b = await instance(a.workspace); b.vault.set("device-private", "NEW_DEVICE_STAYS");
  expect(b.op.restoreBusiness(await decryptBackup(archive, password))).toMatchObject({ reports: 1, routines: 1, routinesPaused: true, reconnectProviders: true });
  expect(b.vault.get("device-private")).toBe("NEW_DEVICE_STAYS"); expect(b.vault.has("provider:openai")).toBe(false); expect(b.vault.has("license")).toBe(false); expect(b.vault.has("claude-profile")).toBe(false);
  expect(b.op.businessContext()).toBe(a.op.businessContext()); expect(b.op.report(report.id)).toEqual(a.op.report(report.id));
  expect(b.op.ledger().slice(0, data.ledger.length)).toEqual(data.ledger);
  expect(b.op.verifyLedger()).toBe(true);
  const restored = b.op.snapshot().automations[0] as any;
  expect(restored.enabled).toBe(0); expect(restored.revision).toBe((a.op.snapshot().automations[0] as any).revision + 1);
  const oldCipher = (a.op.db.query("SELECT result FROM reports").get() as any).result;
  expect(() => b.vault.unseal(oldCipher, "report:" + report.id)).toThrow();
  expect(readFileSync(join(b.root, "operations.sqlite")).includes(Buffer.from("Fictional report"))).toBe(false);
  b.op.db.close(); b.vault.lock(); await b.vault.unlock("fictional local password only");
  const reopened = new Operations(join(b.root, "operations.sqlite"), a.workspace, b.vault, async () => {}); databases.push(reopened);
  expect(reopened.report(report.id).text).toContain("Fictional report"); expect(reopened.businessContext()).toContain("notary A"); expect(reopened.verifyLedger()).toBe(true);
  await reopened.tick(); expect(reopened.snapshot().reports).toHaveLength(1);
});

test("wrong passphrase, tampering and foreign workspace leave the destination empty", async () => {
  const a = await instance(), b = await instance(); a.op.saveContext("Fictional bookshop B");
  const box = await encryptBackup(a.op.exportBusiness(), password);
  await expect(decryptBackup(JSON.stringify(box), "wrong fictional password")).rejects.toThrow("BACKUP_UNLOCK_FAILED");
  await expect(decryptBackup(JSON.stringify({ ...box, tag: "0".repeat(32) }), password)).rejects.toThrow("BACKUP_UNLOCK_FAILED");
  expect(() => b.op.restoreBusiness(a.op.exportBusiness())).toThrow("BACKUP_WORKSPACE_MISMATCH");
  expect(b.op.businessContext()).toBe(""); expect(b.op.ledger()).toHaveLength(0);
  await expect(encryptBackup({}, "short")).rejects.toThrow("BACKUP_PASSPHRASE_LENGTH");
  await expect(decryptBackup(JSON.stringify({ ...box, kdf: "scrypt-unbounded" }), password)).rejects.toThrow("INVALID_BACKUP");
  await expect(decryptBackup(JSON.stringify({ ...box, unexpected: true }), password)).rejects.toThrow("INVALID_BACKUP");
  await expect(encryptBackup("x".repeat(4 * 1024 * 1024), password)).rejects.toThrow("BACKUP_TOO_LARGE");
});

test("corrupt ledger, duplicate rows and injected write failure roll back the whole restore", async () => {
  const a = await instance(); a.op.saveContext("Fictional notary C");
  await a.op.run("operations", "openai", "One draft");
  const original = a.op.exportBusiness(), b = await instance(a.workspace);
  const corrupt = structuredClone(original) as any; corrupt.ledger[0].digest = "0".repeat(64);
  expect(() => b.op.restoreBusiness(corrupt)).toThrow("BACKUP_LEDGER_INVALID");
  const duplicate = structuredClone(original) as any; duplicate.reports.push(duplicate.reports[0]);
  expect(() => b.op.restoreBusiness(duplicate)).toThrow("INVALID_BACKUP_CONTENT");
  // Crash-like database error after settings insert: transaction rollback includes context.
  b.op.db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
  expect(() => b.op.restoreBusiness(original)).toThrow("fixture write failure");
  expect(b.op.businessContext()).toBe(""); expect(b.op.ledger()).toHaveLength(0); expect(b.op.snapshot().reports).toHaveLength(0);
  b.op.db.exec("DROP TRIGGER fixture_fail"); b.op.restoreBusiness(original);
  expect(() => b.op.restoreBusiness(original)).toThrow("RESTORE_REQUIRES_EMPTY_WORKSPACE");
  expect(b.op.snapshot().reports).toHaveLength(1);
});

test("restored interrupted work stays unknown and locked vault cannot export or restore", async () => {
  const a = await instance(), data = a.op.exportBusiness() as any;
  data.reports.push({ id: randomUUID(), automation: null, agent: "operations", state: "running", started: Date.now(), finished: null, result: null, revision: 0 });
  const b = await instance(a.workspace); b.op.restoreBusiness(data);
  expect((b.op.snapshot().reports[0] as any).state).toBe("outcome_unknown");
  b.vault.lock(); expect(() => b.op.exportBusiness()).toThrow("VAULT_LOCKED"); expect(() => b.op.restoreBusiness(data)).toThrow("VAULT_LOCKED");
});

test("process death inside restore leaves no partial records after restart", async () => {
  const a = await instance(); a.op.saveContext("Fictional crash recovery business");
  await a.op.run("operations", "openai", "First report");
  const data = a.op.exportBusiness(), b = await instance(a.workspace);
  b.op.db.close(); b.vault.lock();
  const script = `
    import { LocalVault } from ${JSON.stringify(join(import.meta.dir, "../src/corestrum/local/vault.ts"))};
    import { Operations } from ${JSON.stringify(join(import.meta.dir, "../src/corestrum/local/operations.ts"))};
    const vault = new LocalVault(${JSON.stringify(join(b.root, "vault.enc"))});
    await vault.unlock("fictional local password only");
    const op = new Operations(${JSON.stringify(join(b.root, "operations.sqlite"))},${JSON.stringify(a.workspace)},vault,async()=>{});
    const seal = vault.seal.bind(vault);
    vault.seal = (text, aad) => { if (aad.startsWith("report:")) process.kill(process.pid, "SIGKILL"); return seal(text, aad); };
    op.restoreBusiness(JSON.parse(await Bun.stdin.text()));
    process.exit(9);`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdin: new Blob([JSON.stringify(data)]), stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
  expect(await child.exited).not.toBe(0);
  expect(child.signalCode).toBe("SIGKILL");
  await b.vault.unlock("fictional local password only");
  const recovered = new Operations(join(b.root, "operations.sqlite"), a.workspace, b.vault, async () => {}); databases.push(recovered);
  expect(recovered.businessContext()).toBe(""); expect(recovered.snapshot().reports).toHaveLength(0); expect(recovered.ledger()).toHaveLength(0);
  expect(recovered.restoreBusiness(data)).toMatchObject({ reports: 1 }); expect(recovered.verifyLedger()).toBe(true);
});

test("scheduler and read-only checks cannot keep an unattended vault unlocked", async () => {
  let now=10000;
  const root=mkdtempSync(join(tmpdir(),"corestrum-idle-"));roots.push(root);
  const vault=new LocalVault(join(root,"vault.enc"),()=>now);await vault.unlock("fictional local password only");
  const op=new Operations(join(root,"ops.sqlite"),randomUUID(),vault,async()=>{vault.touch();},undefined,()=>now);databases.push(op);
  for(let i=0;i<31;i++){now+=30000;await op.tick();}
  expect(vault.unlocked).toBe(false);
});

test("explicit owner activity renews the idle deadline; locked access cannot renew itself", async () => {
  let now=10000;const root=mkdtempSync(join(tmpdir(),"corestrum-activity-"));roots.push(root);
  const vault=new LocalVault(join(root,"vault.enc"),()=>now);await vault.unlock("fictional local password only");
  now+=10*60000;vault.activity();now+=10*60000;expect(vault.unlocked).toBe(true);
  now+=6*60000;expect(vault.unlocked).toBe(false);expect(()=>vault.activity()).toThrow("VAULT_LOCKED");
});
