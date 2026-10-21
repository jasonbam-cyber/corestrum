import { randomUUID } from "node:crypto";
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  SignJWT,
  type JWK,
} from "jose";
import type { Database } from "bun:sqlite";
import { seal, unseal } from "../runtime/vault";
import {
  audit,
  auditSchema,
  Denied,
  fields,
  hash,
  privateDb,
  uuid,
} from "./common";
import type { Principal } from "./identity";
import { bridgeEndpoint } from "../../bridge/supabase/functions/waypoint-bridge/handler";

type Installation = {
  id: string;
  project: string;
  accounts: string;
  grant_version: number;
  state: "pending" | "active" | "revoked";
  private_key: string;
  public_key: string;
  revision: number;
};
export type Transport = (body: string, token: string) => Promise<Response>;
export class CustomerRuntime {
  readonly db: Database;
  constructor(
    readonly org: string,
    path: string,
    private readonly key: Buffer,
    readonly project: string,
    private readonly transport: Transport,
  ) {
    if (!uuid(org) || key.length !== 32)
      throw new Error("INVALID_CUSTOMER_CONFIG");
    bridgeEndpoint(project);
    this.db = privateDb(path, "production-customer:" + org);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS installations(id TEXT PRIMARY KEY, project TEXT NOT NULL, accounts TEXT NOT NULL, grant_version INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')), private_key TEXT NOT NULL, public_key TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;`,
    );
    auditSchema(this.db);
  }
  private installation(id: string): Installation {
    const i = this.db
      .query("SELECT * FROM installations WHERE id=?")
      .get(id) as Installation | null;
    if (!i || i.project !== this.project || i.state === "revoked")
      throw new Denied("NOT_FOUND", 404);
    return i;
  }
  snapshot() {
    return {
      org: this.org,
      project: this.project,
      installations: this.db
        .query(
          "SELECT id,project,accounts,grant_version,state,revision FROM installations ORDER BY rowid DESC LIMIT 20",
        )
        .all(),
      events: this.db
        .query("SELECT * FROM security_events ORDER BY seq DESC LIMIT 50")
        .all(),
    };
  }
  async prepare(accounts: unknown, actor: string) {
    if (
      !Array.isArray(accounts) ||
      accounts.length < 1 ||
      accounts.length > 20 ||
      !accounts.every(uuid) ||
      new Set(accounts).size !== accounts.length
    )
      throw new Denied("INVALID_ACCOUNTS", 400);
    if (
      this.db.query("SELECT 1 FROM installations WHERE state!='revoked'").get()
    )
      throw new Denied("REVOKE_EXISTING_INSTALLATION_FIRST", 409);
    const id = randomUUID(),
      pair = await generateKeyPair("EdDSA", { extractable: true }),
      jwk = await exportJWK(pair.publicKey);
    const privateKey = seal(
      this.key,
      this.org,
      id,
      await exportPKCS8(pair.privateKey),
    );
    this.db
      .transaction(() => {
        if (
          this.db
            .query("SELECT 1 FROM installations WHERE state!='revoked'")
            .get()
        )
          throw new Denied("REVOKE_EXISTING_INSTALLATION_FIRST", 409);
        this.db
          .query("INSERT INTO installations VALUES(?,?,?,?,?,?,?,1)")
          .run(
            id,
            this.project,
            JSON.stringify(accounts),
            1,
            "pending",
            privateKey,
            JSON.stringify(jwk),
          );
        audit(this.db, actor, "bridge.prepared", id);
      })
      .immediate();
    return this.manifest(id);
  }
  manifest(id: string) {
    const i = this.installation(id);
    return {
      installation: i.id,
      org: this.org,
      project_ref: i.project,
      version: i.grant_version,
      public_key: JSON.parse(i.public_key) as JWK,
      accounts: JSON.parse(i.accounts) as string[],
      capabilities: ["records.read"],
      endpoint: bridgeEndpoint(i.project),
    };
  }
  private async request(i: Installation, body: Record<string, unknown>) {
    const text = JSON.stringify(body),
      privateKey = await importPKCS8(
        unseal(this.key, this.org, i.id, i.private_key),
        "EdDSA",
      );
    const token = await new SignJWT({
      org: this.org,
      project_ref: i.project,
      grant_version: i.grant_version,
      body_hash: hash(text),
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(`urn:waypoint:runtime:${this.org}`)
      .setSubject(i.id)
      .setAudience(bridgeEndpoint(i.project))
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(privateKey);
    const response = await this.transport(text, token);
    if (!response.ok) throw new Denied("BRIDGE_REJECTED_OR_UNAVAILABLE", 502);
    const result = await response.text();
    if (Buffer.byteLength(result) > 32768)
      throw new Denied("BRIDGE_RESPONSE_TOO_LARGE", 502);
    // A disconnect during an in-flight call invalidates its result.
    const current = this.installation(i.id);
    if (current.revision !== i.revision) throw new Denied("GRANT_CHANGED", 409);
    return JSON.parse(result);
  }
  async verify(id: string, actor: string) {
    const i = this.installation(id),
      d = await this.request(i, { operation: "discover" });
    if (
      d.installation !== id ||
      d.org !== this.org ||
      d.project_ref !== i.project ||
      d.version !== i.grant_version ||
      JSON.stringify(d.capabilities) !== JSON.stringify(["records.read"]) ||
      JSON.stringify(d.accounts) !== i.accounts
    )
      throw new Denied("INSTALLATION_BINDING_MISMATCH", 409);
    this.db
      .transaction(() => {
        const changed = this.db
          .query(
            "UPDATE installations SET state='active' WHERE id=? AND revision=? AND state!='revoked'",
          )
          .run(id, i.revision);
        if (changed.changes !== 1) throw new Denied("GRANT_CHANGED", 409);
        audit(this.db, actor, "bridge.verified", id);
      })
      .immediate();
    return { verified: true, installation: id, capabilities: ["records.read"] };
  }
  async read(id: string, resource: string, account: string, actor: string) {
    const i = this.installation(id);
    if (i.state !== "active")
      throw new Denied("VERIFY_INSTALLATION_FIRST", 409);
    if (
      !uuid(resource) ||
      !uuid(account) ||
      !(JSON.parse(i.accounts) as string[]).includes(account)
    )
      throw new Denied("NOT_FOUND", 404);
    const value = await this.request(i, {
      operation: "records.read",
      resource,
      account,
    });
    const r = value.record;
    if (
      !r ||
      r.id !== resource ||
      r.account_id !== account ||
      typeof r.title !== "string" ||
      r.title.length > 500 ||
      !["open", "closed"].includes(r.status) ||
      !Number.isSafeInteger(r.version) ||
      r.version < 1
    )
      throw new Denied("INVALID_BRIDGE_RESPONSE", 502);
    audit(this.db, actor, "bridge.record.read", id); // No source content in audit/storage.
    return {
      record: {
        id: r.id,
        account_id: r.account_id,
        title: r.title,
        status: r.status,
        version: r.version,
      },
    };
  }
  revoke(id: string, actor: string) {
    this.installation(id);
    this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE installations SET state='revoked',private_key='',revision=revision+1 WHERE id=?",
          )
          .run(id);
        audit(this.db, actor, "bridge.revoked", id);
      })
      .immediate();
    return {
      revoked: true,
      customerAction:
        "Also deactivate the installation in your Supabase project. Already issued requests expire within 30 seconds.",
    };
  }
  async dispatch(principal: Principal, command: string, input: unknown) {
    if (
      principal.org !== this.org ||
      !/^[a-f0-9]{64}$/.test(principal.actor) ||
      !["owner", "viewer"].includes(principal.role)
    )
      throw new Denied("NOT_FOUND", 404);
    const accepted: Record<string, string[]> = {
      snapshot: [],
      prepare: ["accounts"],
      manifest: ["installation"],
      verify: ["installation"],
      read: ["installation", "resource", "account"],
      revoke: ["installation"],
    };
    if (!Object.hasOwn(accepted, command))
      throw new Denied("CAPABILITY_DENIED");
    fields(input, accepted[command]);
    if (command === "snapshot") return this.snapshot();
    if (principal.role !== "owner") throw new Denied("OWNER_REQUIRED");
    if (command === "prepare")
      return this.prepare(input.accounts, principal.actor);
    if (!uuid(input.installation)) throw new Denied("NOT_FOUND", 404);
    if (command === "manifest") return this.manifest(input.installation);
    if (command === "verify")
      return this.verify(input.installation, principal.actor);
    if (command === "read")
      return this.read(
        input.installation,
        String(input.resource),
        String(input.account),
        principal.actor,
      );
    return this.revoke(input.installation, principal.actor);
  }
  close() {
    this.db.close();
  }
}
