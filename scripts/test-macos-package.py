#!/usr/bin/env python3
"""Local package/process qualification, not a clean-Mac or live-provider test.

Runs the production Swift supervisor against the actual app copied from its DMG.
Uses fictional empty workspaces, no license override, network account or AI key.
Never emits a launch URL, local session, passphrase or activation proof.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import selectors
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


parser = argparse.ArgumentParser()
parser.add_argument("--package-evidence", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
if platform.system() != "Darwin" or not args.output.is_absolute() or args.output.exists():
    raise SystemExit("macOS and a new absolute output directory are required")
os.umask(0o077)
args.output.mkdir(parents=True, mode=0o700)
root = Path(__file__).resolve().parents[1]
package = json.loads(args.package_evidence.read_text())
checks = []
processes = []
mounted = False
legacy_socket = None
mount = None
harness = args.output / "HostHarness"


def check(name, condition):
    checks.append({"name": name, "pass": bool(condition)})
    if not condition:
        raise AssertionError(name)


def run(command):
    # Commands contain public artifact paths. Do not relay unbounded tool output.
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if result.returncode:
        raise AssertionError("command failed: " + Path(command[0]).name + " " + command[1])
    return result.stdout


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def launch(data, bundle=None):
    env = {"PATH": "/usr/bin:/bin", "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
           "BUN_BE_BUN": "1", "BUN_OPTIONS": "--preload=/nonexistent-corestrum-fixture.js"}
    proc = subprocess.Popen([str(harness), str(bundle or app), str(data)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    processes.append(proc)
    with selectors.DefaultSelector() as selector:
        selector.register(proc.stdout, selectors.EVENT_READ)
        if not selector.select(20):
            raise AssertionError("supervisor readiness timeout")
        value = json.loads(proc.stdout.readline())
    if value["type"] == "error":
        proc.wait(timeout=10)
        return proc, value, None
    parts = urllib.parse.urlsplit(value["url"])
    origin = urllib.parse.urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    return proc, value, origin


def request(origin, path, body=None, cookie=None, csrf=None, extra=None):
    headers = {"Origin": origin, "Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    if csrf:
        headers["X-CSRF-Token"] = csrf
    headers.update(extra or {})
    req = urllib.request.Request(origin + path,
                                 data=None if body is None else json.dumps(body).encode(), headers=headers)
    # Ignore proxy environment and never follow a redirect off this local runtime.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    content = response.read()
    try:
        content = json.loads(content)
    except (ValueError, UnicodeDecodeError):
        pass
    return response.status, content, response.headers


def session(value, origin):
    token = urllib.parse.parse_qs(urllib.parse.urlsplit(value["url"]).fragment)["launch"][0]
    status, body, headers = request(origin, "/api/local/session", {"token": token})
    check("private single-use bootstrap", status == 200 and len(body["csrf"]) == 43)
    cookie = headers["Set-Cookie"].split(";")[0]
    check("session cookie protections", "HttpOnly" in headers["Set-Cookie"] and "SameSite=Strict" in headers["Set-Cookie"])
    check("bootstrap replay denied", request(origin, "/api/local/session", {"token": token})[0] == 403)
    return cookie, body["csrf"]


def closed(origin):
    for _ in range(80):
        try:
            request(origin, "/api/config")
        except (OSError, urllib.error.URLError):
            return True
        time.sleep(0.1)
    return False


def stop(proc, origin):
    if proc.poll() is None:
        proc.stdin.write(b"quit\n")
        proc.stdin.flush()
        proc.wait(timeout=10)
    check("supervisor quit exits cleanly", proc.returncode == 0)
    check("quit closes owned listener", closed(origin))


failure = None
try:
    check("disk image matches recorded hash", digest(Path(package["dmg"])) == package["dmgSha256"])
    run(["/usr/bin/hdiutil", "verify", package["dmg"]])
    attached = plistlib.loads(run(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-plist", package["dmg"]]))
    mount = Path(next(x["mount-point"] for x in attached["system-entities"] if "mount-point" in x))
    mounted = True
    source = mount / Path(package["app"]).name
    app = args.output / "Applications With Spaces" / source.name
    app.parent.mkdir()
    run(["/usr/bin/ditto", str(source), str(app)])
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])
    check("copied bundle files match package inventory", all(digest(app / f["path"]) == f["sha256"] for f in package["files"]))
    notices = app / "Contents/Resources/Dependency Licenses"
    check("copied notice inventory matches package receipt", digest(notices / "inventory.json") == package["notices"]["manifestSha256"])
    notice_manifest = json.loads((notices / "inventory.json").read_text())
    check("runtime redistribution gap stays explicit", notice_manifest["redistributionCleared"] is False and notice_manifest["runtime"]["nativeInventoryComplete"] is False and notice_manifest["runtime"]["sourceRelinkMaterialsComplete"] is False)
    check("pinned runtime overview matches upstream hash", digest(notices / "BUN-UPSTREAM-LICENSE.md") == notice_manifest["runtime"]["upstreamLicenseSha256"])
    check("bundled notice texts match their hashes", all(
        digest(notices / (p["name"].replace("/", "__") + "@" + p["version"]) / f["name"]) == f["sha256"]
        for p in notice_manifest["packages"] for f in p["files"]))
    check("font and server dependency notices included", {"@fontsource-variable/inter", "jose"}.issubset({p["name"] for p in notice_manifest["packages"]}))
    check("Mac support matrix ships with app", (app / "Contents/Resources/MAC-SUPPORT.md").is_file())
    check("setup guide survives copying the app", digest(app / "Contents/Resources/MAC-SETUP.md") == digest(root / "docs/MAC-SETUP.md"))
    check("disk image includes exact setup guide", digest(mount / "Setup Instructions.md") == digest(root / "docs/MAC-SETUP.md"))
    check("copied app retains project license and notices", all(
        digest(app / "Contents/Resources" / name) == digest(root / name)
        for name in ("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md")))
    check("disk image includes project license and notices", all(
        digest(mount / name) == digest(root / name)
        for name in ("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md")))
    run(["/usr/bin/hdiutil", "detach", str(mount)])
    mounted = False
    cache = args.output / "swift-cache"
    cache.mkdir()
    run(["/usr/bin/swiftc", "-swift-version", "5", "-O", "-module-cache-path", str(cache),
         str(root / "packaging/macos/RuntimeHost.swift"), str(root / "packaging/macos/HostHarness.swift"), "-o", str(harness)])
    export_harness = args.output / "ExportHarness"
    run(["/usr/bin/swiftc", "-swift-version", "5", "-O", "-module-cache-path", str(cache),
         str(root / "packaging/macos/PrivateExport.swift"), str(root / "packaging/macos/ExportHarness.swift"), "-o", str(export_harness)])
    run([str(export_harness), str(args.output / "private-exports")])
    check("private export mode and atomic no-overwrite", True)
    try:
        legacy_socket = socket.socket()
        legacy_socket.bind(("127.0.0.1", 4393))
        legacy_socket.listen()
    except OSError:
        if legacy_socket:
            legacy_socket.close()
        legacy_socket = None  # Existing app owns it; do not touch that process.
    a = args.output / "Fictional Juniper Notary"
    b = args.output / "Fictional Cedar Services"
    pa, va, oa = launch(a)
    check("packaged runtime starts without Bun or Node on PATH", va["type"] == "ready")
    check("runtime avoids legacy fixed port", urllib.parse.urlsplit(oa).port != 4393)
    check("packaged UI loads from moved app", request(oa, "/")[0] == 200)
    check("packaged config is local", request(oa, "/api/config")[1]["mode"] == "local")
    check("anonymous state denied", request(oa, "/api/local/state")[0] == 401)
    check("host spoof denied", request(oa, "/api/config", extra={"Host": "attacker.invalid"})[0] == 403)
    ca, xa = session(va, oa)
    check("new workspace locked", request(oa, "/api/local/state", cookie=ca)[1]["unlocked"] is False)
    check("CSRF-less unlock denied", request(oa, "/api/local/unlock", {"password": "unused fixture value"}, ca)[0] == 403)
    check("cross-origin unlock denied", request(oa, "/api/local/unlock", {}, ca, xa, {"Origin": "https://attacker.invalid"})[0] == 403)
    password = "fictional-package-" + os.urandom(24).hex()
    check("create private vault", request(oa, "/api/local/unlock", {"password": password}, ca, xa)[0] == 200)
    community = request(oa, "/api/config")[1].get("edition") == "community"
    activation = request(oa, "/api/local/activation", {}, ca, xa)
    if community:
        check("community has no paid activation", activation[0] == 403 and activation[1]["error"] == "NOT_AVAILABLE_IN_COMMUNITY")
        access = request(oa, "/api/local/state", cookie=ca)[1]["license"]
        check("community unlock opens local workspace", access["edition"] == "community")
        device = access["workspace"]
    else:
        check("activation request uses public device key only", activation[0] == 200 and "d" not in activation[1]["publicKey"])
        device = activation[1]["device"]
        check("activation does not fabricate entitlement", request(oa, "/api/local/state", cookie=ca)[1]["license"] is None)
    duplicate, rejected, _ = launch(a)
    check("concurrent same-workspace process denied", rejected.get("code") == "WORKSPACE_ALREADY_OPEN")
    check("denied duplicate preserves existing process", request(oa, "/api/local/state", cookie=ca)[1]["unlocked"] is True)
    pb, vb, ob = launch(b)
    check("two fictional businesses have separate ports", ob != oa and vb["type"] == "ready")
    cb, xb = session(vb, ob)
    check("workspace A session denied in B", request(ob, "/api/local/state", cookie=ca)[0] == 401)
    check("second vault creates separately", request(ob, "/api/local/unlock", {"password": password + "-other"}, cb, xb)[0] == 200)
    other_identity = (request(ob, "/api/local/state", cookie=cb)[1]["license"]["workspace"] if community
                      else request(ob, "/api/local/activation", {}, cb, xb)[1]["device"])
    check("workspace identities are isolated", other_identity != device)
    stop(pb, ob)
    stop(pa, oa)
    check("workspace and vault permissions private", a.stat().st_mode & 0o077 == 0 and (a / "vault.enc").stat().st_mode & 0o077 == 0)
    check("vault contains no plaintext passphrase or device identifier", password.encode() not in (a / "vault.enc").read_bytes() and device.encode() not in (a / "vault.enc").read_bytes())
    pa, va, oa = launch(a)
    ca, xa = session(va, oa)
    state = request(oa, "/api/local/state", cookie=ca)[1]
    check("reopen preserves vault but starts locked", state["vaultExists"] and not state["unlocked"])
    check("reopen accepts original passphrase", request(oa, "/api/local/unlock", {"password": password}, ca, xa)[0] == 200)
    reopened_identity = (request(oa, "/api/local/state", cookie=ca)[1]["license"]["workspace"] if community
                         else request(oa, "/api/local/activation", {}, ca, xa)[1]["device"])
    check("reopen preserves workspace identity", reopened_identity == device)
    pa.kill()
    pa.wait(timeout=5)
    check("GUI crash closes child listener through EOF", closed(oa))
    pa, va, oa = launch(a)
    check("OS releases stale lock after process exit", va["type"] == "ready")
    stop(pa, oa)
    unsafe = args.output / "unsafe"
    unsafe.mkdir(mode=0o755)
    unsafe.chmod(0o755)
    check("shared data directory rejected", launch(unsafe)[1].get("code") == "PRIVATE_DATA_DIRECTORY_REQUIRED")
    link = args.output / "linked-workspace"
    link.symlink_to(a, target_is_directory=True)
    check("symlink data directory rejected", launch(link)[1].get("code") == "PRIVATE_DATA_DIRECTORY_REQUIRED")
    target = args.output / "untouched-fixture"
    target.write_text("preserve this fixture")
    for kind in ("symlink", "hardlink"):
        data = args.output / (kind + "-lock")
        data.mkdir(mode=0o700)
        if kind == "symlink":
            (data / "desktop.lock").symlink_to(target)
        else:
            os.link(target, data / "desktop.lock")
        check(kind + " lock rejected", launch(data)[1].get("code") == "PRIVATE_DATA_DIRECTORY_REQUIRED")
    check("unsafe lock target preserved", target.read_text() == "preserve this fixture")
except Exception as error:
    # Only known assertion names or exception classes; never private HTTP values.
    failure = str(error) if isinstance(error, AssertionError) else type(error).__name__
finally:
    for proc in processes:
        if proc.poll() is None:
            try:
                proc.stdin.close()
                proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                proc.kill()
                proc.wait(timeout=5)
    if legacy_socket:
        legacy_socket.close()
    if mounted:
        run(["/usr/bin/hdiutil", "detach", str(mount)])
    evidence = {"schema": "corestrum.mac-package-qualification.v1", "sourceHead": package["sourceHead"],
                "sourceDirty": package["sourceDirty"], "dmgSha256": package["dmgSha256"],
                "hostOS": platform.mac_ver()[0], "architecture": platform.machine(),
                "checks": checks, "failure": failure, "pass": failure is None,
                "scope": "local copied DMG, production supervisor, fictional empty workspaces",
                "independentCleanMacGatekeeper": False, "hostedOnboarding": False,
                "customerAuthentication": False, "customerReady": False}
    (args.output / "qualification.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"passed": sum(x["pass"] for x in checks), "failed": failure, "evidence": str(args.output / "qualification.json")}))
if failure:
    raise SystemExit(1)
