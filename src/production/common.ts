import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export class Denied extends Error {
  constructor(
    public code: string,
    public status = 403,
  ) {
    super(code);
  }
}
export const opaque = () => randomBytes(32).toString("hex");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const uuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s);
export const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function fields(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Denied("INVALID_INPUT", 400);
}
export function secretFile(path: string): Buffer {
  const s = statSync(path);
  if (!s.isFile() || s.mode & 0o077)
    throw new Error("SECRET_FILE_MUST_BE_PRIVATE");
  return readFileSync(path);
}
export function privateDb(path: string, identity: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL) STRICT",
  );
  db.query("INSERT OR IGNORE INTO identity VALUES (1, ?)").run(identity);
  if (
    (db.query("SELECT value FROM identity").get() as { value: string })
      .value !== identity
  ) {
    db.close();
    throw new Error("WRONG_CUSTOMER_VOLUME");
  }
  return db;
}
export function audit(
  db: Database,
  actor: string,
  event: string,
  resource: string,
) {
  db.query(
    "INSERT INTO security_events(at,actor,event,resource) VALUES(?,?,?,?)",
  ).run(new Date().toISOString(), actor, event, resource);
}
export function auditSchema(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS security_events(seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, resource TEXT NOT NULL) STRICT;
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON security_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON security_events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`);
}
export function httpsOrigin(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new Error("HTTPS_ORIGIN_REQUIRED");
  return u.origin;
}
