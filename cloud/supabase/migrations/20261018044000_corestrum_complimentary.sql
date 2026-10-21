-- Separate, append-only operator authority. Never install operator credentials in the web app.
ALTER TABLE corestrum_private.accounts ADD CONSTRAINT account_subject_workspace UNIQUE(subject,workspace);
CREATE ROLE corestrum_grants NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA corestrum_private TO corestrum_grants;
GRANT SELECT ON corestrum_private.accounts TO corestrum_grants;
CREATE POLICY grant_operator_accounts ON corestrum_private.accounts FOR SELECT TO corestrum_grants USING(true);

CREATE TABLE corestrum_private.complimentary_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL UNIQUE,
  workspace uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('staging','production')),
  approval_reference text NOT NULL CHECK(length(trim(approval_reference)) BETWEEN 3 AND 200),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 1000),
  granted_by name NOT NULL DEFAULT session_user,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(subject,workspace) REFERENCES corestrum_private.accounts(subject,workspace)
);
CREATE TABLE corestrum_private.complimentary_revocations (
  grant_id uuid PRIMARY KEY REFERENCES corestrum_private.complimentary_grants(id),
  approval_reference text NOT NULL CHECK(length(trim(approval_reference)) BETWEEN 3 AND 200),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 1000),
  revoked_by name NOT NULL DEFAULT session_user,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE corestrum_private.complimentary_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.complimentary_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.complimentary_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE corestrum_private.complimentary_revocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON corestrum_private.complimentary_grants,corestrum_private.complimentary_revocations FROM PUBLIC;
GRANT SELECT ON corestrum_private.complimentary_grants,corestrum_private.complimentary_revocations TO corestrum_licensing,corestrum_grants;
GRANT INSERT(subject,workspace,environment,approval_reference,reason) ON corestrum_private.complimentary_grants TO corestrum_grants;
GRANT INSERT(grant_id,approval_reference,reason) ON corestrum_private.complimentary_revocations TO corestrum_grants;
CREATE POLICY complimentary_read ON corestrum_private.complimentary_grants FOR SELECT TO corestrum_licensing,corestrum_grants USING(true);
CREATE POLICY revocations_read ON corestrum_private.complimentary_revocations FOR SELECT TO corestrum_licensing,corestrum_grants USING(true);
CREATE POLICY complimentary_append ON corestrum_private.complimentary_grants FOR INSERT TO corestrum_grants WITH CHECK(true);
CREATE POLICY revocations_append ON corestrum_private.complimentary_revocations FOR INSERT TO corestrum_grants WITH CHECK(true);

-- Serialize grants/revocations with checkout and issuance even for a direct operator INSERT.
CREATE FUNCTION corestrum_private.check_complimentary_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog,corestrum_private AS $$
DECLARE a corestrum_private.accounts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.subject,0));
  SELECT * INTO a FROM corestrum_private.accounts WHERE subject=NEW.subject;
  IF a.subject IS NULL OR a.workspace <> NEW.workspace OR a.billing_hold OR a.state <> 'unpaid'
     OR a.customer IS NOT NULL OR a.checkout IS NOT NULL OR a.subscription IS NOT NULL OR a.payment_intent IS NOT NULL THEN
    RAISE EXCEPTION 'COMPLIMENTARY_ACCOUNT_INELIGIBLE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION corestrum_private.lock_complimentary_revocation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog,corestrum_private AS $$
DECLARE owner_subject text;
BEGIN
  SELECT subject INTO owner_subject FROM corestrum_private.complimentary_grants WHERE id=NEW.grant_id;
  IF owner_subject IS NULL THEN RAISE EXCEPTION 'GRANT_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_subject,0));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION corestrum_private.check_complimentary_grant(),corestrum_private.lock_complimentary_revocation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION corestrum_private.check_complimentary_grant(),corestrum_private.lock_complimentary_revocation() TO corestrum_grants;
CREATE TRIGGER check_grant BEFORE INSERT ON corestrum_private.complimentary_grants FOR EACH ROW EXECUTE FUNCTION corestrum_private.check_complimentary_grant();
CREATE TRIGGER lock_revocation BEFORE INSERT ON corestrum_private.complimentary_revocations FOR EACH ROW EXECUTE FUNCTION corestrum_private.lock_complimentary_revocation();
