import type postgres from "postgres";

export type ComplimentaryGrant = {
  id: string;
  subject: string;
  workspace: string;
  environment: "staging" | "production";
  approval_reference: string;
  reason: string;
};
export type GrantRequest = {
  subject: string;
  workspace: string;
  environment: ComplimentaryGrant["environment"];
  approvalReference: string;
  reason: string;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validateGrantRequest(value: unknown): asserts value is GrantRequest {
  const v = value as GrantRequest;
  if (!v || typeof v !== "object" || Array.isArray(v) ||
    Object.keys(v).sort().join(",") !== "approvalReference,environment,reason,subject,workspace" ||
    typeof v.subject !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.subject) ||
    typeof v.workspace !== "string" || !uuid.test(v.workspace) ||
    !["staging", "production"].includes(v.environment) ||
    typeof v.approvalReference !== "string" || v.approvalReference.trim().length < 3 || v.approvalReference.length > 200 ||
    typeof v.reason !== "string" || v.reason.trim().length < 3 || v.reason.length > 1000)
    throw Error("INVALID_GRANT_REQUEST");
}

/** Operator-only client. SQL privileges, not this function or an email, confer grant authority. */
export async function grantComplimentary(sql: postgres.Sql, request: GrantRequest) {
  validateGrantRequest(request);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${request.subject},0))`;
    const existing = (await tx<ComplimentaryGrant[]>`SELECT * FROM corestrum_private.complimentary_grants WHERE subject=${request.subject}`)[0];
    if (existing) {
      const revoked = await tx`SELECT grant_id FROM corestrum_private.complimentary_revocations WHERE grant_id=${existing.id}`;
      if (revoked.length || existing.workspace !== request.workspace || existing.environment !== request.environment || existing.approval_reference !== request.approvalReference || existing.reason !== request.reason)
        throw Error("GRANT_CONFLICT");
      return { id: existing.id, created: false };
    }
    const row = (await tx<{id: string}[]>`INSERT INTO corestrum_private.complimentary_grants(subject,workspace,environment,approval_reference,reason) VALUES(${request.subject},${request.workspace},${request.environment},${request.approvalReference},${request.reason}) RETURNING id`)[0]!;
    return { id: row.id, created: true };
  });
}

export async function revokeComplimentary(sql: postgres.Sql, grantId: string, approvalReference: string, reason: string) {
  if (!uuid.test(grantId) || approvalReference.trim().length < 3 || approvalReference.length > 200 || reason.trim().length < 3 || reason.length > 1000)
    throw Error("INVALID_GRANT_REQUEST");
  // An immutable revocation blocks future issuance; it cannot erase an offline perpetual license.
  await sql`INSERT INTO corestrum_private.complimentary_revocations(grant_id,approval_reference,reason) VALUES(${grantId},${approvalReference},${reason})`;
}
