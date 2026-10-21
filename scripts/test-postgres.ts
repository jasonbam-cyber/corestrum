import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { bridgeHandler } from "../bridge/supabase/functions/waypoint-bridge/handler";
import { assertRestrictedRole } from "../bridge/supabase/functions/waypoint-bridge/permissions";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { hash } from "../src/production/common";

// Creates a disposable cluster with Unix sockets only. Never uses an existing DB URL.
const root = mkdtempSync(
  join(process.env.TEST_SCRATCH ?? tmpdir(), "wp-postgres-"),
);
const socket = mkdtempSync(join(tmpdir(), "wp-pg-socket-"));
const bin = process.env.PG_BIN ?? "";
const command = (name: string, args: string[]) => {
  const result = Bun.spawnSync([bin ? join(bin, name) : name, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode) throw new Error(name + ": " + result.stderr.toString());
};
let db: ReturnType<typeof postgres> | undefined,
  restricted: ReturnType<typeof postgres> | undefined,
  started = false;
let assertions = 0;
const check = (yes: unknown, message: string) => {
  assertions++;
  if (!yes) throw new Error(message);
};
const rejects = async (fn: () => Promise<unknown>, message: string) => {
  let denied = false;
  try {
    await fn();
  } catch {
    denied = true;
  }
  check(denied, message);
};
try {
  command("initdb", [
    "-D",
    join(root, "data"),
    "--auth=trust",
    "--username=waypoint_test_admin",
    "--no-locale",
  ]);
  command("pg_ctl", [
    "-D",
    join(root, "data"),
    "-l",
    join(root, "server.log"),
    "-o",
    `-k '${socket}' -c listen_addresses='' -p 55439`,
    "-w",
    "start",
  ]);
  started = true;
  db = postgres({
    host: socket,
    port: 55439,
    username: "waypoint_test_admin",
    database: "postgres",
    max: 1,
  });
  const migration = readdirSync("bridge/supabase/migrations").find((f) =>
    f.endsWith("_waypoint_bridge.sql"),
  )!;
  await db.unsafe(
    readFileSync(join("bridge/supabase/migrations", migration), "utf8"),
  );
  await db`alter role waypoint_bridge login`;
  const org = randomUUID(),
    installation = randomUUID(),
    account = randomUUID(),
    foreign = randomUUID(),
    record = randomUUID(),
    otherRecord = randomUUID(),
    project = "aaaaaaaaaaaaaaaaaaaa";
  const keys = await generateKeyPair("EdDSA"),
    publicKey = await exportJWK(keys.publicKey);
  await db`insert into waypoint_private.installation values(true,${installation},${org},${project},1,${db.json(publicKey as any)},true,${db.array([account])}::uuid[])`;
  await db`insert into waypoint_private.records values(${record},${account},'Allowed projection','open',1),(${otherRecord},${foreign},'Foreign secret','open',1)`;
  restricted = postgres({
    host: socket,
    port: 55439,
    username: "waypoint_bridge",
    database: "postgres",
    max: 2,
  });
  const r = restricted;
  await assertRestrictedRole(r);
  await db`alter table waypoint_private.records disable row level security`;
  await rejects(() => assertRestrictedRole(r), "Disabled RLS was not detected");
  await db`alter table waypoint_private.records enable row level security`;
  await db`create table public.unrelated_secret(value text)`;
  await db`grant select on public.unrelated_secret to public`;
  await rejects(
    () => assertRestrictedRole(r),
    "PUBLIC table grants were not detected",
  );
  await db`revoke select on public.unrelated_secret from public`;
  await db`create function public.unsafe_definer() returns integer language sql security definer as 'select 1'`;
  await rejects(
    () => assertRestrictedRole(r),
    "PUBLIC definer execution was not detected",
  );
  await db`revoke execute on function public.unsafe_definer() from public`;
  await db`create role other_bridge_role nologin`;
  await db`grant other_bridge_role to waypoint_bridge`;
  await rejects(
    () => assertRestrictedRole(r),
    "Role switching permission was not detected",
  );
  await db`revoke other_bridge_role from waypoint_bridge`;
  await assertRestrictedRole(r);
  const visible =
    await r`select id,account_id,title,status,version from waypoint_private.records`;
  check(
    visible.length === 1 && visible[0].id === record,
    "RLS must hide foreign account without application filters",
  );
  check(
    (
      await r`select id from waypoint_private.records where id=${otherRecord}::uuid`
    ).length === 0,
    "Foreign record visible",
  );
  await rejects(
    () => r`update waypoint_private.installation set active=false`,
    "Bridge can change grants",
  );
  await rejects(
    () =>
      r`insert into waypoint_private.records values(${randomUUID()},${account},'Injected','open',1)`,
    "Bridge can write source records",
  );
  await rejects(
    () => r`set role waypoint_test_admin`,
    "Bridge can escalate role",
  );
  await rejects(
    () => r`select * from waypoint_private.requests`,
    "Bridge can read replay ledger",
  );
  const handler = bridgeHandler(
    {
      async binding() {
        return (await r`select * from waypoint_private.installation`)[0] as any;
      },
      async consume(n, i, exp) {
        await r`insert into waypoint_private.requests values(${n},${i},to_timestamp(${exp}))`;
      },
      async read(id, a) {
        return (
          ((
            await r`select id,account_id,title,status,version from waypoint_private.records where id=${id}::uuid and account_id=${a}::uuid`
          )[0] as any) ?? null
        );
      },
    },
    project,
  );
  const body = JSON.stringify({
    operation: "records.read",
    resource: record,
    account,
  });
  const sign = () =>
    new SignJWT({
      org,
      project_ref: project,
      grant_version: 1,
      body_hash: hash(body),
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(`urn:waypoint:runtime:${org}`)
      .setSubject(installation)
      .setAudience(
        `https://${project}.supabase.co/functions/v1/waypoint-bridge`,
      )
      .setIssuedAt()
      .setExpirationTime("30s")
      .setJti(randomUUID())
      .sign(keys.privateKey);
  const send = (token: string) =>
    handler(
      new Request(
        `https://${project}.supabase.co/functions/v1/waypoint-bridge`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body,
        },
      ),
    );
  const token = await sign();
  check((await send(token)).status === 200, "Authenticated bridge read failed");
  check(
    (await send(token)).status === 401,
    "Replay not rejected by durable unique nonce",
  );
  const racing = await sign(),
    outcomes = await Promise.all(Array.from({ length: 6 }, () => send(racing)));
  check(
    outcomes.filter((r) => r.status === 200).length === 1,
    "Concurrent replay admitted",
  );
  await db`update waypoint_private.installation set active=false,version=2`;
  check(
    (await r`select id from waypoint_private.records`).length === 0,
    "Provider-side revocation fails RLS",
  );
  check((await send(await sign())).status === 401, "Revoked bridge accepted");
  const flags =
    await db`select relname,relrowsecurity,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='waypoint_private' and c.relkind='r'`;
  check(
    flags.length === 3 &&
      flags.every((x) => x.relrowsecurity && x.relforcerowsecurity),
    "Missing forced RLS",
  );
  const role = (
    await db`select * from pg_roles where rolname='waypoint_bridge'`
  )[0];
  check(
    !role.rolsuper &&
      !role.rolbypassrls &&
      !role.rolcreaterole &&
      !role.rolcreatedb &&
      !role.rolinherit,
    "Overprivileged role",
  );
  console.log(
    JSON.stringify({
      ok: true,
      assertions,
      database: "disposable PostgreSQL",
      migration,
      authenticatedRead: true,
      concurrentReplayDenied: true,
      providerRevocation: true,
      liveSupabaseDeployment: false,
    }),
  );
} finally {
  await restricted?.end({ timeout: 2 });
  await db?.end({ timeout: 2 });
  if (started)
    command("pg_ctl", ["-D", join(root, "data"), "-m", "fast", "-w", "stop"]);
  rmSync(root, { recursive: true, force: true });
  rmSync(socket, { recursive: true, force: true });
}
