-- Run only in the customer's explicitly selected project. No default business data.
BEGIN;
CREATE ROLE waypoint_bridge NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA waypoint_private;
REVOKE ALL ON SCHEMA waypoint_private FROM PUBLIC;
GRANT USAGE ON SCHEMA waypoint_private TO waypoint_bridge;
ALTER DEFAULT PRIVILEGES IN SCHEMA waypoint_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE waypoint_private.installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  installation uuid NOT NULL UNIQUE,
  org uuid NOT NULL,
  project_ref text NOT NULL CHECK(project_ref ~ '^[a-z]{20}$'),
  version integer NOT NULL CHECK(version > 0),
  public_key jsonb NOT NULL CHECK(public_key->>'kty'='OKP' AND public_key->>'crv'='Ed25519' AND NOT public_key ? 'd'),
  active boolean NOT NULL DEFAULT false,
  accounts uuid[] NOT NULL CHECK(cardinality(accounts) BETWEEN 1 AND 20)
);
CREATE TABLE waypoint_private.records (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
  status text NOT NULL CHECK(status IN ('open','closed')),
  version integer NOT NULL CHECK(version>0)
);
CREATE INDEX ON waypoint_private.records(account_id);
CREATE TABLE waypoint_private.requests (
  nonce uuid PRIMARY KEY,
  installation uuid NOT NULL REFERENCES waypoint_private.installation(installation),
  expires timestamptz NOT NULL CHECK(expires > now() AND expires <= now()+interval '65 seconds')
);
CREATE INDEX ON waypoint_private.requests(expires);
ALTER TABLE waypoint_private.installation ENABLE ROW LEVEL SECURITY;
ALTER TABLE waypoint_private.installation FORCE ROW LEVEL SECURITY;
ALTER TABLE waypoint_private.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE waypoint_private.records FORCE ROW LEVEL SECURITY;
ALTER TABLE waypoint_private.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE waypoint_private.requests FORCE ROW LEVEL SECURITY;
CREATE POLICY bridge_binding ON waypoint_private.installation FOR SELECT TO waypoint_bridge USING(true);
CREATE POLICY bridge_records ON waypoint_private.records FOR SELECT TO waypoint_bridge
  USING(account_id=ANY((SELECT accounts FROM waypoint_private.installation WHERE singleton AND active)::uuid[]));
CREATE POLICY bridge_nonce ON waypoint_private.requests FOR INSERT TO waypoint_bridge
  WITH CHECK(installation=(SELECT installation FROM waypoint_private.installation WHERE singleton AND active));
GRANT SELECT ON waypoint_private.installation TO waypoint_bridge;
GRANT SELECT(id,account_id,title,status,version) ON waypoint_private.records TO waypoint_bridge;
GRANT INSERT(nonce,installation,expires) ON waypoint_private.requests TO waypoint_bridge;
-- The bridge cannot change grants, read request history, or write source records.
-- PUBLIC has no grants. Keep waypoint_private OUT of Supabase exposed schemas.
COMMIT;
