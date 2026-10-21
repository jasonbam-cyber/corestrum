import { readFileSync } from "node:fs";
import { uuid, fields } from "../src/production/common";
import { bridgeEndpoint } from "../bridge/supabase/functions/waypoint-bridge/handler";
const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: bun scripts/render-bridge-grant.ts MANIFEST.json > grant.sql",
  );
const m = JSON.parse(readFileSync(file, "utf8"));
fields(m, [
  "installation",
  "org",
  "project_ref",
  "version",
  "public_key",
  "accounts",
  "capabilities",
  "endpoint",
]);
fields(m.public_key, ["kty", "crv", "x"]);
if (
  !uuid(m.installation) ||
  !uuid(m.org) ||
  m.version !== 1 ||
  m.public_key.kty !== "OKP" ||
  m.public_key.crv !== "Ed25519" ||
  typeof m.public_key.x !== "string" ||
  !/^[A-Za-z0-9_-]{43}$/.test(m.public_key.x) ||
  !Array.isArray(m.accounts) ||
  m.accounts.length < 1 ||
  m.accounts.length > 20 ||
  !m.accounts.every(uuid) ||
  JSON.stringify(m.capabilities) !== JSON.stringify(["records.read"]) ||
  m.endpoint !== bridgeEndpoint(String(m.project_ref))
)
  throw new Error("INVALID_MANIFEST");
// Values are validated AND quoted. Reinstallation requires explicit revocation, never upsert.
const q = (s: string) => "'" + s.replaceAll("'", "''") + "'";
console.log(
  `-- Review project ${m.project_ref} before executing in its SQL editor.\n-- The bridge's role cannot run this statement. An existing installation fails closed.\nINSERT INTO waypoint_private.installation(singleton,installation,org,project_ref,version,public_key,active,accounts)\nVALUES(true,${q(m.installation)},${q(m.org)},${q(String(m.project_ref))},1,${q(JSON.stringify(m.public_key))}::jsonb,true,ARRAY[${m.accounts.map((a) => q(String(a))).join(",")}]::uuid[]);`,
);
