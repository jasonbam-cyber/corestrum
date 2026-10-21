import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type PackageNotice = { name: string; version: string; license: string; scopes: string[]; files: { name: string; sha256: string }[] };

/** Inventory actual bundler inputs, not the entire installed development dependency tree. */
export function writeDesktopNotices(root: string, destination: string, inputs: { web: string[]; runtime: string[] }, runtimeVersion: string, runtimeRevision: string) {
  const pinned = JSON.parse(readFileSync(join(root, "packaging/notices/bun-runtime.json"), "utf8"));
  if (runtimeVersion !== pinned.version || !runtimeRevision.endsWith("+" + pinned.revision.slice(0, 9))) throw Error("BUN_NOTICE_VERSION_MISMATCH");
  const upstream = readFileSync(join(root, "packaging/notices", pinned.upstreamLicenseFile));
  if (sha256(upstream) !== pinned.upstreamLicenseSha256) throw Error("BUN_NOTICE_HASH_MISMATCH");
  const packages = new Map<string, { path: string; item: PackageNotice }>();
  for (const scope of ["web", "runtime"] as const) for (const input of inputs[scope]) {
    if (input.startsWith("\0") || !input.includes("node_modules/")) continue;
    const path = resolve(root, input.split("?")[0]!);
    if (!existsSync(path)) throw Error("NOTICE_INPUT_MISSING");
    let directory = dirname(realpathSync(path)), found = false;
    while (directory.includes("/node_modules/")) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name && pkg.version) {
          if (typeof pkg.name !== "string" || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(pkg.name) || typeof pkg.version !== "string" || !/^[a-z0-9.+_-]+$/i.test(pkg.version)) throw Error("NOTICE_PACKAGE_INVALID");
          const key = pkg.name + "@" + pkg.version;
          const previous = packages.get(key);
          if (previous && previous.path !== directory) throw Error("NOTICE_DUPLICATE_PACKAGE_LOCATION");
          if (previous) { if (!previous.item.scopes.includes(scope)) previous.item.scopes.push(scope); }
          else packages.set(key, { path: directory, item: { name: pkg.name, version: pkg.version, license: typeof pkg.license === "string" ? pkg.license : "NOASSERTION", scopes: [scope], files: [] } });
          found = true; break;
        }
      }
      directory = dirname(directory);
    }
    if (!found) throw Error("NOTICE_PACKAGE_UNRESOLVED");
  }
  if (!packages.size) throw Error("NOTICE_EMPTY_INVENTORY");
  mkdirSync(destination, { recursive: true });
  const items: PackageNotice[] = [];
  for (const [, { path, item }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const output = join(destination, item.name.replaceAll("/", "__") + "@" + item.version);
    const candidates = readdirSync(path).filter(file => /^(licen[sc]e|copying|notice|ofl)([._-]|$)/i.test(file));
    for (const file of candidates.sort()) {
      const full = join(path, file), stat = lstatSync(full);
      // Fail closed for an unhandled legal-directory format instead of silently omitting it.
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 2 * 1024 * 1024) throw Error("NOTICE_FILE_UNSUPPORTED");
      const data = readFileSync(full);
      mkdirSync(output, { recursive: true }); writeFileSync(join(output, file), data);
      item.files.push({ name: file, sha256: sha256(data) });
    }
    if (!item.files.some(file => /^(licen[sc]e|copying|ofl)([._-]|$)/i.test(file.name))) throw Error("DEPENDENCY_LICENSE_TEXT_MISSING:" + item.name);
    if (item.license === "NOASSERTION") throw Error("DEPENDENCY_LICENSE_METADATA_MISSING:" + item.name);
    item.scopes.sort(); items.push(item);
  }
  writeFileSync(join(destination, "BUN-UPSTREAM-LICENSE.md"), upstream);
  const manifest = {
    schema: "corestrum.desktop-notices.v1", packages: items,
    npmLicenseTextsPresent: true,
    runtime: { name: "Bun", version: runtimeVersion, revision: pinned.revision, sourceURL: pinned.sourceURL, upstreamLicenseURL: pinned.upstreamLicenseURL, upstreamLicenseSha256: pinned.upstreamLicenseSha256, nativeInventoryComplete: false, sourceRelinkMaterialsComplete: false, unresolved: pinned.unresolved },
    externalSoftware: [{ name: "Claude Code", bundled: false, installedAndAuthenticatedByCustomer: true }],
    redistributionCleared: false,
  };
  writeFileSync(join(destination, "inventory.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(destination, "README.txt"), `Corestrum third-party notices\n\n${items.length} JavaScript/font packages were identified from the web and local-runtime build inputs. Each package directory preserves its upstream license and notice files. inventory.json records exact versions, scope and file hashes. This inventory is not a legal clearance.\n\nBun ${runtimeVersion} is embedded in CorestrumRuntime. BUN-UPSTREAM-LICENSE.md is the version-pinned upstream overview, not the full set of native dependency notices. Exact native dependencies, required source/relink materials and distribution terms remain UNRESOLVED. See ${pinned.sourceURL}. Do not publish this qualification artifact as a cleared customer release.\n\nClaude Code is not bundled or relicensed. The customer installs the official unmodified program separately and completes its own authentication flow. macOS supplies AppKit/WebKit; those OS frameworks are not copied into this app.\n`);
  return { packageCount: items.length, manifestSha256: sha256(readFileSync(join(destination, "inventory.json"))), redistributionCleared: false };
}
