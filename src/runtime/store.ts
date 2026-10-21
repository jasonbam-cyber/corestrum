import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import {
  customers,
  Fault,
  type Audit,
  type Org,
  type Principal,
  type Run,
  type Snapshot,
} from "../contracts";

type Connection = { active: number; version: number };
type Issue = {
  id: string;
  external_tenant: string;
  title: string;
  version: number;
};
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const now = () => new Date().toISOString();
const identifier = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v))
    throw new Fault("INVALID_INPUT", 400);
  return v;
};
const money = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > 100_000_000)
    throw new Fault("INVALID_AMOUNT", 400);
  return Number(v);
};

export class CustomerRuntime {
  readonly db: Database;
  constructor(
    readonly org: Org,
    filename: string,
  ) {
    if (!Object.hasOwn(customers, org)) throw new Fault("INVALID_CUSTOMER", 400);
    this.db = new Database(filename, { create: true, strict: true });
    // Refuse an incorrect mount before applying any schema changes to that file.
    if (this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get()) {
      const binding = this.db.query<{value: string}, []>("SELECT value FROM metadata WHERE key='org'").get();
      if (binding?.value !== org) { this.db.close(); throw new Fault("DATABASE_BINDING_MISMATCH"); }
    }
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connection (id INTEGER PRIMARY KEY CHECK(id=1), active INTEGER NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, external_tenant TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, org TEXT NOT NULL, issue_id TEXT NOT NULL REFERENCES issues(id), external_tenant TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, intent_hash TEXT NOT NULL, source_version INTEGER NOT NULL, grant_version INTEGER NOT NULL, created_at TEXT NOT NULL, idem TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS approvals (run_id TEXT PRIMARY KEY REFERENCES runs(id), actor TEXT NOT NULL, intent_hash TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effects (run_id TEXT PRIMARY KEY REFERENCES runs(id), org TEXT NOT NULL, external_tenant TEXT NOT NULL, receipt TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), limit_micros INTEGER NOT NULL CHECK(limit_micros>=0), funding TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, reserved INTEGER NOT NULL CHECK(reserved>=0), actual INTEGER CHECK(actual>=0), state TEXT NOT NULL CHECK(state IN ('held','settled')));
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, org TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, resource TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS run_boundary_insert BEFORE INSERT ON runs WHEN NEW.org IS NOT (SELECT value FROM metadata WHERE key='org') OR NEW.external_tenant IS NOT (SELECT external_tenant FROM issues WHERE id=NEW.issue_id) BEGIN SELECT RAISE(ABORT, 'CUSTOMER_BOUNDARY'); END;
      CREATE TRIGGER IF NOT EXISTS run_boundary_update BEFORE UPDATE ON runs WHEN NEW.org IS NOT (SELECT value FROM metadata WHERE key='org') OR NEW.external_tenant IS NOT (SELECT external_tenant FROM issues WHERE id=NEW.issue_id) BEGIN SELECT RAISE(ABORT, 'CUSTOMER_BOUNDARY'); END;
      CREATE TRIGGER IF NOT EXISTS effect_boundary_insert BEFORE INSERT ON effects WHEN NEW.org IS NOT (SELECT value FROM metadata WHERE key='org') OR NEW.org IS NOT (SELECT org FROM runs WHERE id=NEW.run_id) OR NEW.external_tenant IS NOT (SELECT external_tenant FROM runs WHERE id=NEW.run_id) BEGIN SELECT RAISE(ABORT, 'CUSTOMER_BOUNDARY'); END;
      CREATE TRIGGER IF NOT EXISTS effect_boundary_update BEFORE UPDATE ON effects WHEN NEW.org IS NOT (SELECT value FROM metadata WHERE key='org') OR NEW.org IS NOT (SELECT org FROM runs WHERE id=NEW.run_id) OR NEW.external_tenant IS NOT (SELECT external_tenant FROM runs WHERE id=NEW.run_id) BEGIN SELECT RAISE(ABORT, 'CUSTOMER_BOUNDARY'); END;
      CREATE TRIGGER IF NOT EXISTS audit_boundary_insert BEFORE INSERT ON audit WHEN NEW.org IS NOT (SELECT value FROM metadata WHERE key='org') BEGIN SELECT RAISE(ABORT, 'CUSTOMER_BOUNDARY'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;`);
    this.db
      .transaction(() => {
        const meta = this.db
          .query<
            { value: string },
            []
          >("SELECT value FROM metadata WHERE key='org'")
          .get();
        if (meta && meta.value !== org)
          throw new Fault("DATABASE_BINDING_MISMATCH");
        if (!meta) {
          this.db.query("INSERT INTO metadata VALUES (?,?)").run("org", org);
          this.db.query("INSERT INTO metadata VALUES (?,?)").run("schema", "1");
          this.db.query("INSERT INTO connection VALUES (1,1,1)").run();
          this.db.query("INSERT INTO budget VALUES (1,5000000,'byok')").run();
          for (const account of ["alpha", "beta"])
            this.db
              .query("INSERT INTO issues VALUES (?,?,?,1)")
              .run(
                `${org}-issue-${account}`,
                account,
                account === "alpha"
                  ? "Resolve a billing sync issue"
                  : "Restricted account fixture",
              );
          this.audit("system", "workspace.provisioned", org);
        }
        const interrupted = this.db
          .query<Run, []>("SELECT * FROM runs WHERE state='executing'")
          .all();
        for (const run of interrupted) {
          this.db
            .query("UPDATE runs SET state='outcome_unknown' WHERE id=?")
            .run(run.id);
          this.audit("system", "action.outcome_unknown", run.id);
        }
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
  private authorize(p: Principal, write = false) {
    if (p.org !== this.org) throw new Fault("NOT_FOUND", 404);
    if (
      !["owner", "viewer"].includes(p.role) ||
      !/^(owner|viewer)-(cedar|mesa)$/.test(p.actor)
    )
      throw new Fault("FORBIDDEN");
    if (p.actor !== `${p.role}-${this.org}`) throw new Fault("FORBIDDEN");
    if (write && p.role !== "owner") throw new Fault("OWNER_REQUIRED");
  }
  private connection() {
    return this.db
      .query<Connection, []>("SELECT active,version FROM connection WHERE id=1")
      .get()!;
  }
  private capability(account: string, version?: number) {
    const c = this.connection();
    if (!c.active) throw new Fault("CONNECTION_REVOKED");
    if (account !== "alpha") throw new Fault("NOT_FOUND", 404);
    if (version !== undefined && version !== c.version)
      throw new Fault("APPROVAL_STALE", 409);
    return c;
  }
  private audit(actor: string, event: string, resource: string) {
    const last = this.db
      .query<
        { seq: number; hash: string },
        []
      >("SELECT seq,hash FROM audit ORDER BY seq DESC LIMIT 1")
      .get();
    const row = {
      seq: (last?.seq ?? 0) + 1,
      org: this.org,
      at: now(),
      actor,
      event,
      resource,
      previous_hash: last?.hash ?? "genesis",
    };
    this.db
      .query("INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)")
      .run(
        row.seq,
        row.org,
        row.at,
        actor,
        event,
        resource,
        row.previous_hash,
        digest(row),
      );
  }
  verifyAudit() {
    let previous = "genesis",
      seq = 0;
    for (const row of this.db
      .query<Audit, []>("SELECT * FROM audit ORDER BY seq")
      .all()) {
      const { hash, ...data } = row;
      if (
        row.org !== this.org ||
        row.seq !== ++seq ||
        row.previous_hash !== previous ||
        digest(data) !== hash
      )
        return false;
      previous = hash;
    }
    return seq > 0;
  }
  private getRun(id: unknown) {
    const run = this.db
      .query<
        Run,
        [string, string]
      >("SELECT id,org,issue_id,external_tenant,title,state,intent_hash,source_version,grant_version,created_at FROM runs WHERE id=? AND org=?")
      .get(identifier(id), this.org);
    if (!run) throw new Fault("NOT_FOUND", 404);
    return run;
  }
  private budget() {
    const { limit_micros, funding } = this.db
      .query<
        { limit_micros: number; funding: "byok" | "managed" },
        []
      >("SELECT * FROM budget WHERE id=1")
      .get()!;
    const totals = this.db
      .query<
        { spent: number; held: number },
        []
      >(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE 0 END),0) spent, COALESCE(SUM(CASE WHEN state='held' THEN reserved ELSE 0 END),0) held FROM usage`)
      .get()!;
    return {
      limit: limit_micros,
      ...totals,
      unit: "usd_micros" as const,
      funding,
      simulated: true as const,
    };
  }
  reserve(id: string, amount: number) {
    identifier(id);
    money(amount);
    return this.db
      .transaction(() => {
        const existing = this.db
          .query<
            { reserved: number },
            [string]
          >("SELECT reserved FROM usage WHERE id=?")
          .get(id);
        if (existing) {
          if (existing.reserved !== amount)
            throw new Fault("IDEMPOTENCY_CONFLICT", 409);
          return;
        }
        const b = this.budget();
        if (b.spent + b.held + amount > b.limit)
          throw new Fault("BUDGET_EXCEEDED", 409);
        this.db
          .query("INSERT INTO usage VALUES (?,?,NULL,'held')")
          .run(id, amount);
        this.audit("agent", "usage.reserved", id);
      })
      .immediate();
  }
  settle(id: string, actual: number) {
    identifier(id);
    money(actual);
    this.db
      .transaction(() => {
        const row = this.db
          .query<
            { reserved: number; state: string; actual: number },
            [string]
          >("SELECT * FROM usage WHERE id=?")
          .get(id);
        if (!row) throw new Fault("NOT_FOUND", 404);
        if (row.state === "settled") {
          if (row.actual !== actual)
            throw new Fault("IDEMPOTENCY_CONFLICT", 409);
          return;
        }
        if (actual > row.reserved)
          throw new Fault("RESERVATION_TOO_SMALL", 409);
        this.db
          .query("UPDATE usage SET actual=?,state='settled' WHERE id=?")
          .run(actual, id);
        this.audit("agent", "usage.settled", id);
      })
      .immediate();
  }
  readIssue(p: Principal, id: unknown) {
    this.authorize(p);
    const issue = this.db
      .query<Issue, [string]>("SELECT * FROM issues WHERE id=?")
      .get(identifier(id));
    if (!issue) throw new Fault("NOT_FOUND", 404);
    this.capability(issue.external_tenant);
    return {
      id: issue.id,
      title: issue.title,
      status: "open",
      accountId: issue.external_tenant,
      version: issue.version,
    };
  }
  start(p: Principal, issueId: unknown, key: unknown) {
    this.authorize(p, true);
    const idem = identifier(key);
    return this.db
      .transaction(() => {
        const issue = this.readIssue(p, issueId);
        const existing = this.db
          .query<
            { id: string; issue_id: string },
            [string]
          >("SELECT id,issue_id FROM runs WHERE idem=?")
          .get(idem);
        if (existing) {
          if (existing.issue_id !== issueId)
            throw new Fault("IDEMPOTENCY_CONFLICT", 409);
          return this.getRun(existing.id);
        }
        const grant = this.connection();
        const id = `${this.org}-${randomUUID()}`;
        this.reserve(id, 100_000); // Bounded synthetic model attempt; no provider request.
        const hash = digest([
          this.org,
          issue.id,
          issue.accountId,
          issue.version,
          grant.version,
          "followup.create",
          "Prepare a follow-up for the engineering team.",
        ]);
        this.db
          .query(
            "INSERT INTO runs (id,org,issue_id,external_tenant,title,state,intent_hash,source_version,grant_version,created_at,idem) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            this.org,
            issue.id,
            issue.accountId,
            issue.title,
            "waiting_approval",
            hash,
            issue.version,
            grant.version,
            now(),
            idem,
          );
        this.settle(id, 40_000);
        this.audit(p.actor, "issue.read_scoped", id);
        this.audit("agent", "action.prepared", id);
        this.audit("agent", "approval.requested", id);
        return this.getRun(id);
      })
      .immediate();
  }
  approve(p: Principal, id: unknown, hash: unknown) {
    this.authorize(p, true);
    return this.db
      .transaction(() => {
        const run = this.getRun(id);
        this.checkIntent(run);
        if (run.intent_hash !== hash) throw new Fault("APPROVAL_STALE", 409);
        if (run.state === "approved") return run;
        if (run.state !== "waiting_approval")
          throw new Fault("INVALID_STATE", 409);
        this.db
          .query("INSERT INTO approvals VALUES (?,?,?,?)")
          .run(run.id, p.actor, hash as string, now());
        this.db
          .query("UPDATE runs SET state='approved' WHERE id=?")
          .run(run.id);
        this.audit(p.actor, "action.approved", run.id);
        return this.getRun(run.id);
      })
      .immediate();
  }
  private checkIntent(run: Run) {
    this.capability(run.external_tenant, run.grant_version);
    const issue = this.db
      .query<Issue, [string]>("SELECT * FROM issues WHERE id=?")
      .get(run.issue_id);
    const hash = digest([
      this.org,
      run.issue_id,
      run.external_tenant,
      issue?.version,
      run.grant_version,
      "followup.create",
      "Prepare a follow-up for the engineering team.",
    ]);
    if (
      !issue ||
      issue.version !== run.source_version ||
      issue.external_tenant !== run.external_tenant ||
      hash !== run.intent_hash
    )
      throw new Fault("APPROVAL_STALE", 409);
  }
  execute(p: Principal, id: unknown, loseResponse = false) {
    this.authorize(p, true);
    const run = this.db
      .transaction(() => {
        const r = this.getRun(id);
        // Never re-dispatch an effect whose outcome is uncertain, including after restart.
        if (r.state === "verified" || r.state === "outcome_unknown") return r;
        if (r.state !== "approved") throw new Fault("APPROVAL_REQUIRED", 409);
        this.checkIntent(r);
        const approval = this.db
          .query<
            { intent_hash: string },
            [string]
          >("SELECT intent_hash FROM approvals WHERE run_id=?")
          .get(r.id);
        if (!approval || approval.intent_hash !== r.intent_hash)
          throw new Fault("APPROVAL_REQUIRED", 409);
        this.db.query("UPDATE runs SET state='executing' WHERE id=?").run(r.id);
        this.audit("agent", "action.dispatched", r.id);
        return this.getRun(r.id);
      })
      .immediate();
    if (run.state !== "executing") return run;
    // Synthetic customer bridge. This is a separately committed provider-effect fixture.
    // The stable run key models a provider's idempotency contract; no external I/O exists.
    this.db
      .query("INSERT OR IGNORE INTO effects VALUES (?,?,?,?,?)")
      .run(
        run.id,
        this.org,
        run.external_tenant,
        `fixture-receipt-${randomUUID()}`,
        now(),
      );
    this.db
      .transaction(() => {
        this.db
          .query("UPDATE runs SET state=? WHERE id=?")
          .run(loseResponse ? "outcome_unknown" : "verified", run.id);
        this.audit(
          "agent",
          loseResponse ? "action.outcome_unknown" : "action.verified",
          run.id,
        );
      })
      .immediate();
    return this.getRun(run.id);
  }
  reconcile(p: Principal, id: unknown) {
    this.authorize(p, true);
    return this.db
      .transaction(() => {
        const r = this.getRun(id);
        this.capability(r.external_tenant);
        if (r.state !== "outcome_unknown")
          throw new Fault("INVALID_STATE", 409);
        const effect = this.db
          .query<
            { org: string; external_tenant: string },
            [string]
          >("SELECT org,external_tenant FROM effects WHERE run_id=?")
          .get(r.id);
        if (
          !effect ||
          effect.org !== this.org ||
          effect.external_tenant !== r.external_tenant
        )
          throw new Fault("RECONCILIATION_PENDING", 409);
        this.db.query("UPDATE runs SET state='verified' WHERE id=?").run(r.id);
        this.audit(p.actor, "action.reconciled", r.id);
        return this.getRun(r.id);
      })
      .immediate();
  }
  setConnection(p: Principal, active: boolean) {
    this.authorize(p, true);
    this.db
      .transaction(() => {
        const c = this.connection();
        if (Boolean(c.active) === active) return;
        this.db
          .query("UPDATE connection SET active=?,version=version+1 WHERE id=1")
          .run(active ? 1 : 0);
        this.audit(
          p.actor,
          active ? "connection.fixture_verified" : "connection.revoked",
          this.org,
        );
      })
      .immediate();
  }
  setBudget(p: Principal, limit: unknown, funding: unknown) {
    this.authorize(p, true);
    const amount = money(limit);
    if (!["byok", "managed"].includes(String(funding)))
      throw new Fault("INVALID_INPUT", 400);
    this.db
      .transaction(() => {
        const b = this.budget();
        if (amount < b.held + b.spent)
          throw new Fault("BUDGET_BELOW_COMMITTED_USAGE", 409);
        this.db
          .query("UPDATE budget SET limit_micros=?,funding=? WHERE id=1")
          .run(amount, String(funding));
        this.audit(p.actor, "budget.updated", this.org);
      })
      .immediate();
  }
  snapshot(p: Principal): Snapshot {
    this.authorize(p);
    const c = this.connection();
    return {
      org: this.org,
      name: customers[this.org].name,
      role: p.role,
      synthetic: true,
      connector: {
        active: Boolean(c.active),
        version: c.version,
        externalTenant: "alpha",
        capabilities: c.active ? ["issue.read", "followup.create"] : [],
      },
      budget: this.budget(),
      runs: this.db
        .query<
          Run,
          []
        >("SELECT id,org,issue_id,external_tenant,title,state,intent_hash,source_version,grant_version,created_at FROM runs ORDER BY created_at DESC")
        .all(),
      audit: this.db
        .query<Audit, []>("SELECT * FROM audit ORDER BY seq DESC LIMIT 100")
        .all(),
      auditValid: this.verifyAudit(),
      issueId: customers[this.org].issueId,
    };
  }
  exportAudit(p: Principal) {
    this.authorize(p);
    const valid = this.verifyAudit();
    if (!valid) throw new Fault("AUDIT_INTEGRITY_FAILURE", 409);
    const events = this.db
      .query<Audit, []>("SELECT * FROM audit ORDER BY seq")
      .all();
    return {
      customer: this.org,
      synthetic: true,
      exportedAt: now(),
      events,
      anchor: events.at(-1)?.hash,
      limitation:
        "Local hash chain; not independent immutable storage or an auditor report.",
    };
  }
  dispatch(p: Principal, command: string, input: Record<string, unknown> = {}) {
    this.authorize(p);
    if (!this.verifyAudit()) throw new Fault("AUDIT_INTEGRITY_FAILURE", 409);
    const shapes: Record<string, string[]> = {
      snapshot: [],
      export: [],
      read: ["id"],
      start: ["issueId", "key"],
      approve: ["id", "hash"],
      execute: ["id", "loseResponse"],
      reconcile: ["id"],
      connection: ["active"],
      budget: ["limit", "funding"],
    };
    if (
      !Object.hasOwn(shapes, command) ||
      Object.keys(input).some((k) => !shapes[command].includes(k))
    )
      throw new Fault("INVALID_INPUT", 400);
    try {
      switch (command) {
        case "snapshot":
          return this.snapshot(p);
        case "export":
          return this.exportAudit(p);
        case "read":
          return this.readIssue(p, input.id);
        case "start":
          return this.start(p, input.issueId, input.key);
        case "approve":
          return this.approve(p, input.id, input.hash);
        case "execute":
          if (typeof input.loseResponse !== "boolean")
            throw new Fault("INVALID_INPUT", 400);
          return this.execute(p, input.id, input.loseResponse);
        case "reconcile":
          return this.reconcile(p, input.id);
        case "connection":
          if (typeof input.active !== "boolean")
            throw new Fault("INVALID_INPUT", 400);
          this.setConnection(p, input.active);
          return { ok: true };
        case "budget":
          this.setBudget(p, input.limit, input.funding);
          return { ok: true };
      }
    } catch (e) {
      if (e instanceof Fault)
        this.db
          .transaction(() => this.audit(p.actor, `denied.${e.code}`, command))
          .immediate();
      throw e;
    }
  }
}
