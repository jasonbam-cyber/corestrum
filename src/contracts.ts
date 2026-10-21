export type Org = "cedar" | "mesa";
export type Role = "owner" | "viewer";
export type Principal = { org: Org; actor: string; role: Role };
export type RunState =
  | "waiting_approval"
  | "approved"
  | "executing"
  | "outcome_unknown"
  | "verified";
export type Run = {
  id: string;
  org: Org;
  issue_id: string;
  external_tenant: string;
  title: string;
  state: RunState;
  intent_hash: string;
  source_version: number;
  grant_version: number;
  created_at: string;
};
export type Audit = {
  seq: number;
  org: Org;
  at: string;
  actor: string;
  event: string;
  resource: string;
  previous_hash: string;
  hash: string;
};
export type Snapshot = {
  org: Org;
  name: string;
  role: Role;
  synthetic: true;
  connector: {
    active: boolean;
    version: number;
    capabilities: string[];
    externalTenant: string;
  };
  budget: {
    limit: number;
    spent: number;
    held: number;
    unit: "usd_micros";
    funding: "byok" | "managed";
    simulated: true;
  };
  runs: Run[];
  audit: Audit[];
  auditValid: boolean;
  issueId: string;
};
export const customers: Record<Org, { name: string; issueId: string }> = {
  cedar: { name: "Cedar SaaS", issueId: "cedar-issue-alpha" },
  mesa: { name: "Mesa SaaS", issueId: "mesa-issue-alpha" },
};
export class Fault extends Error {
  constructor(
    public code: string,
    public status = 403,
  ) {
    super(code);
  }
}
