import type postgres from "postgres";
export async function assertRestrictedRole(db: ReturnType<typeof postgres>) {
  const identity =
    await db`select current_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication from pg_roles where rolname=current_user`;
  const r = identity[0];
  if (
    r?.current_user !== "waypoint_bridge" ||
    r.rolsuper ||
    r.rolbypassrls ||
    r.rolcreaterole ||
    r.rolcreatedb ||
    r.rolinherit ||
    r.rolreplication
  )
    throw new Error("RESTRICTED_DATABASE_ROLE_REQUIRED");
  const memberships =
    await db`select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=current_user) limit 1`;
  // NOINHERIT alone does not prevent SET ROLE through an assigned role membership.
  if (memberships.length) throw new Error("BRIDGE_ROLE_MEMBERSHIP_FORBIDDEN");
  const protectedTables =
    await db`select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='waypoint_private' and c.relname in ('installation','records','requests') and c.relkind='r'`;
  if (
    protectedTables.length !== 3 ||
    protectedTables.some((t) => !t.relrowsecurity || !t.relforcerowsecurity)
  )
    throw new Error("BRIDGE_RLS_REQUIRED");
  const writable =
    await db`select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not like 'pg_%' and n.nspname!='information_schema' and c.relkind in ('r','v','m','p','f')
    and (has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
      or has_any_column_privilege(current_user,c.oid,'UPDATE,REFERENCES')
      or (has_any_column_privilege(current_user,c.oid,'INSERT') and not(n.nspname='waypoint_private' and c.relname='requests'))
      or (has_any_column_privilege(current_user,c.oid,'SELECT') and not(n.nspname='waypoint_private' and c.relname in ('records','installation')))) limit 1`;
  const definers =
    await db`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname not like 'pg_%' and n.nspname!='information_schema' and p.prosecdef
    and has_function_privilege(current_user,p.oid,'EXECUTE') limit 1`;
  if (writable.length || definers.length)
    throw new Error("BRIDGE_HAS_EXTRA_PRIVILEGES");
}
