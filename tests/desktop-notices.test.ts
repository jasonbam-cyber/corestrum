import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeDesktopNotices } from "../scripts/desktop-notices";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "corestrum-notices-")); roots.push(root);
  const dir = join(root, "packaging/notices"); mkdirSync(dir, { recursive: true });
  const license = "Fictional runtime license overview; not a release clearance.";
  writeFileSync(join(dir, "RUNTIME.md"), license);
  writeFileSync(join(dir, "bun-runtime.json"), JSON.stringify({ version: "1.4.1", revision: "4661e494f052c83c80dade1318e5710238340be6", upstreamLicenseFile: "RUNTIME.md", upstreamLicenseSha256: createHash("sha256").update(license).digest("hex"), sourceURL: "https://example.invalid/source", upstreamLicenseURL: "https://example.invalid/license", unresolved: ["source and relink materials"] }));
  const pkg = (relative: string, name: string, version: string, licenseText = true) => {
    const path = join(root, relative); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name, version, license: "MIT" }));
    writeFileSync(join(path, "index.js"), "export const example = true;");
    if (licenseText) writeFileSync(join(path, "LICENSE"), "Fictional test license " + version);
    return join(path, "index.js");
  };
  return { root, pkg, output: join(root, "notices") };
}
test("actual inputs include nested versions, deduplicate scopes and omit unused development packages", () => {
  const f = fixture();
  const a = f.pkg("node_modules/@sample/shared", "@sample/shared", "1.0.0");
  const b = f.pkg("node_modules/parent/node_modules/@sample/shared", "@sample/shared", "2.0.0");
  f.pkg("node_modules/unused", "unused", "1.0.0");
  const result = writeDesktopNotices(f.root, f.output, { web: [a, b], runtime: [a] }, "1.4.1", "1.4.1+4661e494f");
  const text = readFileSync(join(f.output, "inventory.json"), "utf8"), inventory = JSON.parse(text);
  expect(result.packageCount).toBe(2); expect(result.redistributionCleared).toBe(false);
  expect(inventory.packages[0].scopes).toEqual(["runtime", "web"]);
  expect(inventory.packages[1].version).toBe("2.0.0");
  expect(text).not.toContain(f.root); expect(text).not.toContain('"unused"');
  expect(inventory.runtime.nativeInventoryComplete).toBe(false);
  expect(inventory.runtime.sourceRelinkMaterialsComplete).toBe(false);
  expect(inventory.externalSoftware[0].bundled).toBe(false);
});
test("missing license text and mismatched runtime identity or overview fail closed", () => {
  const f = fixture(), a = f.pkg("node_modules/no-license", "no-license", "1.0.0", false);
  const run = (version = "1.4.1", revision = "1.4.1+4661e494f") => writeDesktopNotices(f.root, f.output, { web: [a], runtime: [] }, version, revision);
  expect(() => run()).toThrow("DEPENDENCY_LICENSE_TEXT_MISSING:no-license");
  expect(() => run("1.4.2")).toThrow("BUN_NOTICE_VERSION_MISMATCH");
  expect(() => run("1.4.1", "1.4.1+000000000")).toThrow("BUN_NOTICE_VERSION_MISMATCH");
  writeFileSync(join(f.root, "packaging/notices/RUNTIME.md"), "changed");
  expect(() => run()).toThrow("BUN_NOTICE_HASH_MISMATCH");
});
