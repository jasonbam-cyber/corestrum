-- Dedicated Corestrum licensing database only. Never apply to a customer's source database.
CREATE SCHEMA IF NOT EXISTS corestrum_private;
REVOKE ALL ON SCHEMA corestrum_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS corestrum_private.accounts (
  subject text PRIMARY KEY,
  workspace uuid NOT NULL UNIQUE,
  customer text UNIQUE,
  plan text CHECK(plan IN ('monthly','annual','perpetual')),
  state text NOT NULL DEFAULT 'unpaid' CHECK(state IN ('unpaid','active','suspended')),
  billing_hold boolean NOT NULL DEFAULT false,
  checkout text UNIQUE,
  subscription text UNIQUE,
  payment_intent text UNIQUE,
  paid_until bigint,
  updates_until bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS corestrum_private.devices (
  subject text NOT NULL REFERENCES corestrum_private.accounts(subject),
  device text NOT NULL,
  public_key jsonb NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  revoked boolean NOT NULL DEFAULT false,
  PRIMARY KEY(subject,device)
);
CREATE TABLE IF NOT EXISTS corestrum_private.events (
  id text PRIMARY KEY,
  kind text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS corestrum_private.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_hash text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS corestrum_private.nonces (nonce uuid PRIMARY KEY, expires_at timestamptz NOT NULL);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='corestrum_licensing') THEN
    CREATE ROLE corestrum_licensing NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA corestrum_private TO corestrum_licensing;
GRANT SELECT,INSERT,UPDATE ON corestrum_private.accounts,corestrum_private.devices TO corestrum_licensing;
GRANT SELECT,INSERT ON corestrum_private.events,corestrum_private.nonces TO corestrum_licensing;
GRANT INSERT ON corestrum_private.audit TO corestrum_licensing;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA corestrum_private TO corestrum_licensing;
ALTER TABLE corestrum_private.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.devices FORCE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.events FORCE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.audit FORCE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.nonces FORCE ROW LEVEL SECURITY;
-- Only this trusted server role is admitted; there are no anon/authenticated grants.
-- Customer requests still require current Clerk identity and explicit subject predicates.
CREATE POLICY licensing_accounts ON corestrum_private.accounts TO corestrum_licensing USING(true) WITH CHECK(true);
CREATE POLICY licensing_devices ON corestrum_private.devices TO corestrum_licensing USING(true) WITH CHECK(true);
CREATE POLICY licensing_events ON corestrum_private.events TO corestrum_licensing USING(true) WITH CHECK(true);
CREATE POLICY licensing_nonces ON corestrum_private.nonces TO corestrum_licensing USING(true) WITH CHECK(true);
CREATE POLICY licensing_audit ON corestrum_private.audit FOR INSERT TO corestrum_licensing WITH CHECK(true);
REVOKE ALL ON ALL TABLES IN SCHEMA corestrum_private FROM PUBLIC;
