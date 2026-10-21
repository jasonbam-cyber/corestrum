import postgres from "postgres";
import { bridgeHandler, type Binding } from "./handler.ts";
import { assertRestrictedRole } from "./permissions.ts";

// Only the dedicated restricted login's URL belongs in this custom secret.
// Never use Supabase's automatically injected administrator connection URL.
const dbUrl = Deno.env.get("BRIDGE_DATABASE_URL");
const projectUrl = new URL(Deno.env.get("SUPABASE_URL")!);
if (
  !dbUrl ||
  projectUrl.protocol !== "https:" ||
  !/^[a-z]{20}\.supabase\.co$/.test(projectUrl.hostname)
)
  throw new Error("BRIDGE_CONFIGURATION_REQUIRED");
const project = projectUrl.hostname.split(".")[0];
const db = postgres(dbUrl, {
  prepare: false,
  max: 2,
  ssl: { rejectUnauthorized: true },
  connect_timeout: 5,
  idle_timeout: 20,
  connection: { statement_timeout: 3000, application_name: "waypoint-bridge" },
});
await assertRestrictedRole(db);
Deno.serve(
  bridgeHandler(
    {
      async binding() {
        await assertRestrictedRole(db);
        const rows =
          await db`select installation,org,project_ref,version,public_key,active,accounts from waypoint_private.installation where singleton=true`;
        return (rows[0] as Binding | undefined) ?? null;
      },
      async consume(nonce, installation, expires) {
        await db`insert into waypoint_private.requests(nonce,installation,expires) values(${nonce},${installation},to_timestamp(${expires}))`;
      },
      async read(resource, account) {
        const rows =
          await db`select id,account_id,title,status,version from waypoint_private.records where id=${resource}::uuid and account_id=${account}::uuid limit 1`;
        return (
          (rows[0] as
            | {
                id: string;
                account_id: string;
                title: string;
                status: string;
                version: number;
              }
            | undefined) ?? null
        );
      },
    },
    project,
  ),
);
