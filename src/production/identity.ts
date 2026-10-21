import type { Database } from "bun:sqlite";
import { seal, unseal } from "../runtime/vault";
import {
  audit,
  auditSchema,
  Denied,
  hash,
  opaque,
  privateDb,
  uuid,
} from "./common";

export type Member = {
  org: string;
  name: string;
  role: "owner" | "viewer";
  revision: number;
};
export type Identity = {
  issuer: string;
  subject: string;
  accessToken: string;
  expires: number;
};
export type Session = Identity & {
  id: string;
  csrf: string;
  org: string | null;
  revision: number;
  idle: number;
};
export type Principal = {
  org: string;
  actor: string;
  role: "owner" | "viewer";
};

export class IdentityStore {
  readonly db: Database;
  constructor(
    path: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("INVALID_SESSION_KEY");
    this.db = privateDb(path, "production-control-plane-v1");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;
      CREATE TABLE IF NOT EXISTS members(issuer TEXT NOT NULL, subject TEXT NOT NULL, org TEXT NOT NULL REFERENCES customers(id), role TEXT NOT NULL CHECK(role IN ('owner','viewer')), active INTEGER NOT NULL CHECK(active IN (0,1)), revision INTEGER NOT NULL, PRIMARY KEY(issuer,subject,org)) STRICT;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, token TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL, idle INTEGER NOT NULL, org TEXT, revision INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS logins(id TEXT PRIMARY KEY, envelope TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
    `);
    auditSchema(this.db);
  }
  enroll(
    issuer: string,
    subject: string,
    org: string,
    name: string,
    role: "owner" | "viewer",
    active: boolean,
    operator: string,
  ) {
    if (
      !uuid(org) ||
      !subject ||
      subject.length > 255 ||
      !name ||
      !["owner", "viewer"].includes(role) ||
      !operator
    )
      throw new Denied("INVALID_ENROLLMENT", 400);
    this.db
      .transaction(() => {
        this.db
          .query(
            "INSERT INTO customers VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
          )
          .run(org, name);
        this.db
          .query(
            "INSERT INTO members VALUES(?,?,?,?,?,1) ON CONFLICT(issuer,subject,org) DO UPDATE SET role=excluded.role, active=excluded.active, revision=members.revision+1",
          )
          .run(issuer, subject, org, role, Number(active));
        // A change invalidates already selected sessions immediately, including demotions.
        this.db
          .query("DELETE FROM sessions WHERE issuer=? AND subject=? AND org=?")
          .run(issuer, subject, org);
        audit(
          this.db,
          operator,
          active ? "membership.granted" : "membership.revoked",
          org,
        );
      })
      .immediate();
  }
  members(s: Pick<Identity, "issuer" | "subject">): Member[] {
    return this.db
      .query(
        "SELECT m.org,c.name,m.role,m.revision FROM members m JOIN customers c ON c.id=m.org WHERE m.issuer=? AND m.subject=? AND m.active=1 AND c.active=1 ORDER BY c.name",
      )
      .all(s.issuer, s.subject) as Member[];
  }
  login(value: unknown) {
    const id = opaque();
    this.db.query("DELETE FROM logins WHERE expires<?").run(Date.now());
    this.db
      .query("INSERT INTO logins VALUES(?,?,?)")
      .run(
        hash(id),
        seal(this.key, "auth", "login:" + hash(id), JSON.stringify(value)),
        Date.now() + 300_000,
      );
    return id;
  }
  consumeLogin(id: string) {
    const row = this.db
      .query("DELETE FROM logins WHERE id=? RETURNING envelope,expires")
      .get(hash(id)) as { envelope: string; expires: number } | null;
    if (!row || row.expires <= Date.now())
      throw new Denied("LOGIN_EXPIRED", 401);
    return JSON.parse(
      unseal(this.key, "auth", "login:" + hash(id), row.envelope),
    );
  }
  create(identity: Identity) {
    if (!this.members(identity).length) throw new Denied("MEMBERSHIP_REQUIRED");
    const id = opaque(),
      csrf = opaque(),
      expires = Math.min(identity.expires, Date.now() + 3_600_000);
    if (expires <= Date.now()) throw new Denied("SESSION_EXPIRED", 401);
    this.db
      .query("DELETE FROM sessions WHERE expires<? OR idle<?")
      .run(Date.now(), Date.now());
    this.db
      .query("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,0)")
      .run(
        hash(id),
        identity.issuer,
        identity.subject,
        seal(this.key, "auth", hash(id), identity.accessToken),
        csrf,
        expires,
        Date.now() + 900_000,
        null,
      );
    audit(
      this.db,
      hash(identity.issuer + "|" + identity.subject),
      "session.created",
      hash(id),
    );
    return { id, csrf };
  }
  session(id: string): Session {
    const s = this.db
      .query("SELECT * FROM sessions WHERE id=?")
      .get(hash(id)) as
      | (Omit<Session, "accessToken"> & { token: string })
      | null;
    if (!s || s.expires <= Date.now() || s.idle <= Date.now())
      throw new Denied("SESSION_REQUIRED", 401);
    const result = {
      ...s,
      accessToken: unseal(this.key, "auth", hash(id), s.token),
    };
    if (!this.members(result).length) {
      this.revoke(id);
      throw new Denied("MEMBERSHIP_REQUIRED");
    }
    return result;
  }
  touch(id: string) {
    this.db
      .query("UPDATE sessions SET idle=? WHERE id=?")
      .run(Date.now() + 900_000, hash(id));
  }
  select(id: string, org: string) {
    const s = this.session(id),
      m = this.members(s).find((m) => m.org === org);
    if (!m) throw new Denied("NOT_FOUND", 404);
    this.db
      .query("UPDATE sessions SET org=?,revision=? WHERE id=?")
      .run(org, m.revision, hash(id));
    audit(this.db, hash(s.issuer + "|" + s.subject), "customer.selected", org);
  }
  principal(s: Session): Principal {
    const m = this.members(s).find(
      (m) => m.org === s.org && m.revision === s.revision,
    );
    if (!m) throw new Denied("CUSTOMER_SELECTION_REQUIRED", 403);
    return {
      org: m.org,
      role: m.role,
      actor: hash(s.issuer + "|" + s.subject),
    };
  }
  revoke(id: string) {
    this.db.query("DELETE FROM sessions WHERE id=?").run(hash(id));
    audit(this.db, "session", "session.revoked", hash(id));
  }
  close() {
    this.db.close();
  }
}
