import { readFileSync } from "node:fs";
import { IdentityStore } from "../src/production/identity";
import { fields, httpsOrigin, secretFile } from "../src/production/common";
// Offline operator command, never a customer-facing or model-callable endpoint.
// Input includes immutable OIDC issuer + subject, never an email/domain mapping.
const [configFile, enrollmentFile] = process.argv.slice(2);
if (!configFile || !enrollmentFile)
  throw new Error(
    "Usage: bun scripts/enroll-member.ts CONFIG_FILE ENROLLMENT_FILE",
  );
const config = JSON.parse(readFileSync(configFile, "utf8"));
const input = JSON.parse(readFileSync(enrollmentFile, "utf8"));
fields(input, [
  "issuer",
  "subject",
  "org",
  "name",
  "role",
  "active",
  "operator",
]);
httpsOrigin(config.origin);
if (
  input.issuer !== config.issuer ||
  typeof input.active !== "boolean" ||
  typeof input.issuer !== "string" ||
  typeof input.subject !== "string" ||
  typeof input.org !== "string" ||
  typeof input.name !== "string" ||
  typeof input.operator !== "string" ||
  !["owner", "viewer"].includes(String(input.role))
)
  throw new Error("INVALID_ENROLLMENT");
const store = new IdentityStore(
  config.database,
  secretFile(config.sessionKeyFile),
);
try {
  store.enroll(
    input.issuer,
    input.subject,
    input.org,
    input.name,
    input.role as "owner" | "viewer",
    input.active,
    input.operator,
  );
  console.log("Membership change recorded; affected sessions revoked.");
} finally {
  store.close();
}
