import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const files: string[] = [];
function walk(path: string) {
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
}
walk("src");
walk("api");
walk("cloud");
walk("bridge");
walk("deploy");
walk("packaging");
const violations: string[] = [];
for (const path of files) {
  if(path.includes("/.temp/")) continue;
  const content = readFileSync(path, "utf8");
  if (
    /sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      content,
    )
  )
    violations.push(`${path}: possible credential`);
  if (
    /SUPABASE_SERVICE_ROLE|ANTHROPIC_API_KEY|OPENAI_API_KEY|HELM_DB_PATH|\/Users\//.test(
      content,
    )
  )
    violations.push(`${path}: forbidden live/environment binding`);
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log(
  `Boundary/credential-pattern check passed for ${files.length} source files. This is a narrow guard, not comprehensive secret scanning.`,
);
