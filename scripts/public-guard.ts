/** Publication guard: reports filenames/rule names only, never matching secret values. */
import { readFileSync, lstatSync } from "node:fs";
const result = Bun.spawnSync(["git", "ls-files", "-z"], { stdout: "pipe" });
if (result.exitCode) throw Error("TRACKED_FILE_INVENTORY_FAILED");
const paths = result.stdout.toString().split("\0").filter(Boolean);
const failures: string[] = [];
const rules: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["cloud-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["provider-secret", /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{35,}\b/],
  ["credential-url", /(?:postgres(?:ql)?|https?):\/\/[^\s/:]+:[^\s/@]+@/],
];
for (const path of paths) {
  if (/(^|\/)(?:\.env(?!\.example$)(?:\.[^/]+)?|\.vercel|\.deployment|\.data)(?:\/|$)|\.(?:sqlite|db|pem|p12|pfx|key|dmg|zip|log)$|(^|\/)release-config\.json$/.test(path)) failures.push(`${path}: private/generated artifact`);
  if (lstatSync(path).isSymbolicLink()) { failures.push(`${path}: tracked symlink`); continue; }
  const text = readFileSync(path, "utf8");
  // This guard's pattern definitions are not themselves credentials.
  if (path !== "scripts/public-guard.ts") for (const [rule, pattern] of rules) {
    for (const line of text.split("\n")) {
      // Demonstrably invalid credentials are negative tests, never usable service values.
      if (path.startsWith("tests/") && /example|fixture|test|name:secret|wrong|forbidden/.test(line)) continue;
      if (pattern.test(line)) failures.push(`${path}: ${rule}`);
    }
  }
  if (path.startsWith(".github/workflows/") && /self-hosted|pull_request_target|secrets\./.test(text)) failures.push(`${path}: privileged workflow`);
}
if (failures.length) { console.error([...new Set(failures)].join("\n")); process.exit(1); }
console.log(`Publication guard passed for ${paths.length} tracked paths. Pattern checks are not proof of absence of secrets.`);
