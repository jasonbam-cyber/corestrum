import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { validateDesktopRelease } from "../src/corestrum/local/release-config";
import { writeDesktopNotices } from "./desktop-notices";

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
  output: { type: "string" }, "release-config": { type: "string" },
  qualification: { type: "boolean", default: false }, identity: { type: "string" },
} });
if (process.platform !== "darwin") throw Error("MACOS_BUILD_HOST_REQUIRED");
if (!values.output || !isAbsolute(values.output) || existsSync(values.output) || !values["release-config"])
  throw Error("NEW_ABSOLUTE_OUTPUT_AND_PUBLIC_RELEASE_CONFIG_REQUIRED");
if (values.qualification === Boolean(values.identity) || (values.identity && !values.identity.startsWith("Developer ID Application: ")))
  throw Error("CHOOSE_QUALIFICATION_OR_EXISTING_DEVELOPER_ID_IDENTITY");
const release = await validateDesktopRelease(JSON.parse(readFileSync(values["release-config"], "utf8")));
const root = resolve(import.meta.dir, ".."), output = values.output;
const arch = process.arch;
if (!["arm64", "x64"].includes(arch)) throw Error("UNSUPPORTED_ARCHITECTURE");
const productName = release.edition === "community" ? "Corestrum Community" : "Corestrum";
const name = values.qualification ? productName + " Preview" : productName;
const layout = join(output, "disk"), app = join(layout, name + ".app");
const resources = join(app, "Contents/Resources"), macos = join(app, "Contents/MacOS");
mkdirSync(resources, { recursive: true }); mkdirSync(macos, { recursive: true });
mkdirSync(join(output, "build-cache")); mkdirSync(join(output, "empty-env"));
const run = (args: string[]) => {
  const result = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    // Build commands contain only source/public config paths, never customer credentials.
    process.stderr.write(result.stderr);
    throw Error(`BUILD_STEP_FAILED:${basename(args[0]!)}`);
  }
  return result.stdout.toString().trim();
};
const webInputs: string[] = [];
await build({ configFile: false, root, envDir: join(output, "empty-env"), envPrefix: [],
  plugins: [react(), { name: "desktop-notice-inputs", generateBundle() { webInputs.push(...this.getModuleIds()); } }], build: { outDir: join(resources, "web"), emptyOutDir: true,
    rollupOptions: { input: join(root, "corestrum.html") }, sourcemap: false } });
renameSync(join(resources, "web/corestrum.html"), join(resources, "web/index.html"));
writeFileSync(join(resources, "release-config.json"), JSON.stringify(release, null, 2) + "\n");
const runtime = join(macos, "CorestrumRuntime");
const runtimeMetafile = join(output, "runtime-metafile.json");
run([process.execPath, "build", "--compile", "--minify", "--env=disable",
  "--metafile=" + runtimeMetafile,
  "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json",
  "src/corestrum/local/desktop.ts", "--outfile", runtime]);
run(["/usr/bin/swiftc", "-swift-version", "5", "-O", "-target", `${arch === "x64" ? "x86_64" : arch}-apple-macos14.0`,
  "-module-cache-path", join(output, "build-cache"), "-framework", "AppKit", "-framework", "WebKit",
  "packaging/macos/RuntimeHost.swift", "packaging/macos/PrivateExport.swift", "packaging/macos/main.swift", "-o", join(macos, "Corestrum")]);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("INVALID_VERSION");
writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.corestrum.${release.edition === "community" ? "community" : "licensed"}${values.qualification ? ".preview" : ""}</string>
<key>CFBundleName</key><string>${name}</string><key>CFBundleDisplayName</key><string>${name}</string>
<key>CFBundleExecutable</key><string>Corestrum</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>CorestrumCommunityBuild</key><${release.edition === "community" ? "true" : "false"}/>
<key>CorestrumQualificationBuild</key><${values.qualification ? "true" : "false"}/>
</dict></plist>\n`);
const noticeEvidence = writeDesktopNotices(root, join(resources, "Dependency Licenses"), {
  web: webInputs, runtime: Object.keys(JSON.parse(readFileSync(runtimeMetafile, "utf8")).inputs),
}, Bun.version, run([process.execPath, "--revision"]));
writeFileSync(join(resources, "RUNTIME-NOTICE.txt"), "See Dependency Licenses/README.txt and inventory.json for exact bundled package notices and unresolved native-runtime redistribution requirements.\n");
writeFileSync(join(resources, "MAC-SUPPORT.md"), readFileSync(join(root, "docs/MAC-SUPPORT.md")));
writeFileSync(join(resources, "MAC-SETUP.md"), readFileSync(join(root, "docs/MAC-SETUP.md")));
const identity = values.identity ?? "-";
const signing = ["--force", "--sign", identity, "--options", "runtime", ...(values.identity ? ["--timestamp"] : [])];
run(["/usr/bin/codesign", ...signing, "--entitlements", "packaging/macos/runtime.entitlements.plist", runtime]);
run(["/usr/bin/codesign", ...signing, app]);
run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
run(["/usr/bin/plutil", "-lint", join(app, "Contents/Info.plist")]);
symlinkSync("/Applications", join(layout, "Applications"));
writeFileSync(join(layout, "Read Me.txt"), `${name}\nDrag the app to Applications, then open it. No Bun, Node or repository checkout is needed.\nBusiness data stays in your Application Support/${name} folder. Quitting locks the vault and stops local routines.\n${values.qualification ? "UNPUBLISHED LOCAL QUALIFICATION BUILD. Ad-hoc signed only; not Developer ID signed, notarized, or approved for customer installation. Do not bypass Gatekeeper warnings.\n" : "Verify release acceptance, signature, notarization and the published checksum before customer distribution.\n"}See Setup Instructions.md for first-use guidance. Your own AI account is required. Corestrum does not fund AI usage.\n`);
writeFileSync(join(layout, "Setup Instructions.md"), readFileSync(join(root, "docs/MAC-SETUP.md")));
const dmg = join(output, `Corestrum-${values.qualification ? "preview-" : ""}${arch}.dmg`);
run(["/usr/bin/hdiutil", "create", "-volname", name, "-srcfolder", layout, "-format", "UDZO", dmg]);
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const files: { path: string; sha256: string }[] = [];
function inventory(path: string, prefix = "") {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const relative = join(prefix, entry.name), full = join(path, entry.name);
    if (entry.isSymbolicLink()) throw Error("UNEXPECTED_BUNDLE_SYMLINK");
    if (entry.isDirectory()) inventory(full, relative);
    else files.push({ path: relative, sha256: sha256(full) });
  }
}
inventory(app);
const evidence = { schema: "corestrum.mac-package.v1", sourceHead: run(["git", "rev-parse", "HEAD"]),
  sourceDirty: Boolean(run(["git", "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)node_modules"])), version, arch, bun: Bun.version,
  minimumOSDeclared: "14.0", app, dmg, dmgSha256: sha256(dmg), files,
  signature: values.qualification ? "ad-hoc hardened runtime, local qualification only" : "Developer ID signature; not yet notarized",
  notices: noticeEvidence, notarized: false, independentCleanMacTested: false, customerReady: false };
writeFileSync(join(output, "package-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ app, dmg, dmgSha256: evidence.dmgSha256, customerReady: false }));
