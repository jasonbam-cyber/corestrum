import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { readBody } from "../http";
import { validateDesktopRelease, type DesktopRelease } from "./release-config";
import { LocalVault } from "./vault";
import { Operations } from "./operations";
import { BACKUP_MAX_BYTES, encryptBackup, decryptBackup } from "./backup";
import { LocalClaude } from "./claude";
import { draft, provider, providerSnapshot, saveProvider } from "./ai";
import { verifyLicense, type License } from "../license";
import { fingerprint } from "../device";
import { AGENTS, PRODUCT, type AgentId } from "../catalog";
import { CustomerRuntime } from "../../production/customer";
import { bridgeEndpoint } from "../../../bridge/supabase/functions/waypoint-bridge/handler";
import { hash } from "../../production/common";

export type LocalConfig = {
  data: string;
  origin: string;
  assets: string;
} & DesktopRelease;
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function localApp(config: LocalConfig) {
  const origin = new URL(config.origin);
  if (
    origin.hostname !== "127.0.0.1" ||
    origin.protocol !== "http:" ||
    origin.origin !== config.origin
  )
    throw new Error("LOOPBACK_REQUIRED");
  if (config.edition !== "community") {
    const cloud = new URL(config.cloudOrigin);
    if (cloud.protocol !== "https:" || cloud.origin !== config.cloudOrigin)
      throw new Error("HTTPS_CLOUD_REQUIRED");
  }
  mkdirSync(config.data, { recursive: true, mode: 0o700 });
  const info = lstatSync(config.data);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("PRIVATE_DATA_DIRECTORY_REQUIRED");
  const vault = new LocalVault(join(config.data, "vault.enc"));
  const claude = new LocalClaude(join(config.data, "claude"));
  let operations: Operations | undefined, bridge: CustomerRuntime | undefined;
  const bootstrap = randomBytes(32).toString("base64url");
  let bootstrapUsed = false,
    session = "",
    csrf = "",
    sessionAt = 0,
    unlockFailures = 0,
    unlockAfter = 0;
  let license: License | { workspace: string; plan: "community"; edition: "community" } | undefined;
  const entitle = async () => {
    vault.touch();
    if (config.edition === "community") {
      if (vault.has("license")) throw new Error("SEPARATE_COMMUNITY_VAULT_REQUIRED");
      const workspace = vault.get("community-workspace");
      if (!workspace) throw new Error("COMMUNITY_WORKSPACE_REQUIRED");
      license = { workspace, plan: "community", edition: "community" };
      return;
    }
    const raw = vault.get("license"),
      publicKey = vault.get("device-public");
    if (!raw || !publicKey) throw new Error("LICENSE_REQUIRED");
    license = await verifyLicense(raw, config.licensePublicKey, {
      device: fingerprint(JSON.parse(publicKey)),
      environment: config.environment,
      major: PRODUCT.major,
    });
  };
  const openOperations = async () => {
    await entitle();
    if (!operations)
      operations = new Operations(
        join(config.data, "operations.sqlite"),
        license!.workspace,
        vault,
        entitle,
        (vault, p, agent, prompt, context) => p === "claude-code" ? claude.draft(vault, agent, prompt, context) : draft(vault, p, agent, prompt, context),
      );
    return operations;
  };
  const customer = async () => {
    await entitle();
    const project = vault.get("supabase-project");
    if (!project) throw new Error("SUPABASE_NOT_CONNECTED");
    if (!bridge) {
      const key = vault.get("bridge-encryption-key");
      if (!key) throw new Error("SUPABASE_NOT_CONNECTED");
      bridge = new CustomerRuntime(
        license!.workspace,
        join(config.data, "customer.sqlite"),
        Buffer.from(key, "hex"),
        project,
        async (body, token) =>
          fetch(bridgeEndpoint(project), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + token,
            },
            body,
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          }),
      );
    }
    return bridge;
  };
  const json = (
    value: unknown,
    status = 200,
    extra: Record<string, string> = {},
  ) =>
    Response.json(value, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        ...extra,
      },
    });
  async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (
        url.origin !== config.origin ||
        (request.headers.get("host") &&
          request.headers.get("host") !== origin.host)
      )
        throw new Error("HOST_REJECTED");
      if (
        url.pathname.startsWith("/api/") &&
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new Error("ORIGIN_REJECTED");
      if (url.pathname === "/api/config" && request.method === "GET")
        return json({
          mode: "local",
          product: PRODUCT,
          edition: config.edition ?? "licensed",
          environment: config.edition === "community" ? "local" : config.environment,
          ...(config.edition === "community" ? {} : { cloudOrigin: config.cloudOrigin }),
        });
      if (!url.pathname.startsWith("/api/")) {
        if (request.method !== "GET") return json({ error: "NOT_FOUND" }, 404);
        const path = url.pathname.startsWith("/assets/")
          ? resolve(config.assets, "." + url.pathname)
          : join(config.assets, "index.html");
        if (!path.startsWith(resolve(config.assets) + "/"))
          throw new Error("NOT_FOUND");
        const file = Bun.file(path);
        if (!(await file.exists())) return json({ error: "NOT_FOUND" }, 404);
        return new Response(file, {
          headers: {
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            "x-frame-options": "DENY",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (
        request.method === "POST" &&
        (request.headers.get("origin") !== config.origin ||
          !request.headers.get("content-type")?.startsWith("application/json"))
      )
        throw new Error("ORIGIN_REJECTED");
      if (request.method === "POST" && url.pathname === "/api/local/session") {
        const raw = await readBody(request, 32768);
        if (raw.length > 200) throw new Error("INVALID_REQUEST");
        const b = JSON.parse(raw);
        if (bootstrapUsed || !equal(String(b.token), bootstrap))
          throw new Error("LAUNCH_LINK_EXPIRED");
        bootstrapUsed = true;
        session = randomBytes(32).toString("base64url");
        csrf = randomBytes(32).toString("base64url");
        sessionAt = Date.now();
        return json({ csrf, vaultExists: vault.exists }, 200, {
          "set-cookie": `corestrum_local=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
        });
      }
      const cookies = (request.headers.get("cookie") ?? "")
        .split(";")
        .map((x) => x.trim())
        .filter((x) => x.startsWith("corestrum_local="));
      if (
        !session ||
        cookies.length !== 1 ||
        !equal(cookies[0]!.slice(16), session) ||
        Date.now() - sessionAt > 12 * 3600000
      )
        throw new Error("LOCAL_SESSION_REQUIRED");
      if (request.method === "GET" && url.pathname === "/api/local/state") {
        let entitled = false;
        if (vault.unlocked) {
          try {
            await entitle();
            entitled = true;
          } catch {}
        }
        return json({
          csrf,
          vaultExists: vault.exists,
          unlocked: vault.unlocked,
          license: entitled ? license : null,
          providers: vault.unlocked ? providerSnapshot(vault) : [],
          businessContext: entitled ? (await openOperations()).businessContext() : "",
          operations: entitled ? (await openOperations()).snapshot() : null,
          supabase: vault.unlocked
            ? {
                project: vault.get("supabase-project") ?? null,
                installations: bridge?.snapshot().installations ?? [],
              }
            : null,
        });
      }
      if (
        request.method !== "POST" ||
        !equal(request.headers.get("x-csrf-token") ?? "", csrf)
      )
        throw new Error("CSRF_REJECTED");
      const bodyLimit = url.pathname === "/api/local/backup/restore" ? BACKUP_MAX_BYTES + 8192 : 32768;
      const raw = await readBody(request, bodyLimit);
      if (Buffer.byteLength(raw) > bodyLimit) throw new Error("BODY_TOO_LARGE");
      const b = JSON.parse(raw);
      if (url.pathname === "/api/local/unlock") {
        if (Date.now() < unlockAfter) throw new Error("TRY_AGAIN_LATER");
        try {
          await vault.unlock(b.password);
          unlockFailures = 0;
        } catch {
          unlockAfter =
            Date.now() +
            Math.min(60000, 1000 * 2 ** Math.min(++unlockFailures, 6));
          throw new Error("VAULT_UNLOCK_FAILED");
        }
        if (config.edition === "community") {
          if (vault.has("license")) { vault.lock(); throw new Error("SEPARATE_COMMUNITY_VAULT_REQUIRED"); }
          if (!vault.has("community-workspace")) vault.set("community-workspace", randomUUID());
        } else if (vault.has("community-workspace")) {
          vault.lock(); throw new Error("SEPARATE_LICENSED_VAULT_REQUIRED");
        }
        if (config.edition !== "community" && !vault.has("device-public")) {
          const keys = await generateKeyPair("EdDSA", { extractable: true });
          vault.set(
            "device-public",
            JSON.stringify(await exportJWK(keys.publicKey)),
          );
          vault.set(
            "device-private",
            JSON.stringify(await exportJWK(keys.privateKey)),
          );
        }
        return json({ unlocked: true });
      }
      if (url.pathname === "/api/local/lock") {
        claude.cancel();
        vault.lock();
        license = undefined;
        bridge?.db.close();
        bridge = undefined;
        return json({ locked: true });
      }
      // Only an authenticated, CSRF-checked owner POST extends the idle deadline.
      vault.activity();
      if (url.pathname === "/api/local/activation") {
        if (config.edition === "community") throw new Error("NOT_AVAILABLE_IN_COMMUNITY");
        const key = JSON.parse(vault.get("device-public")!),
          device = fingerprint(key);
        const proof = await new SignJWT({})
          .setProtectedHeader({ alg: "EdDSA", typ: "corestrum-device+jwt" })
          .setSubject(device)
          .setAudience(config.cloudOrigin + "/api/license/activate")
          .setJti(randomUUID())
          .setIssuedAt()
          .setExpirationTime("60s")
          .sign(
            await importJWK(JSON.parse(vault.get("device-private")!), "EdDSA"),
          );
        return json({ publicKey: key, device, proof });
      }
      if (url.pathname === "/api/local/license") {
        if (config.edition === "community") throw new Error("NOT_AVAILABLE_IN_COMMUNITY");
        const checked = await verifyLicense(
          String(b.license),
          config.licensePublicKey,
          {
            device: fingerprint(JSON.parse(vault.get("device-public")!)),
            environment: config.environment,
            major: PRODUCT.major,
          },
        );
        if (
          vault.get("workspace") &&
          vault.get("workspace") !== checked.workspace
        )
          throw new Error("WORKSPACE_MISMATCH");
        vault.set("workspace", checked.workspace);
        vault.set("license", b.license);
        license = checked;
        return json({ activated: true });
      }
      if (url.pathname === "/api/local/license/refresh") {
        if (config.edition === "community") throw new Error("NOT_AVAILABLE_IN_COMMUNITY");
        const workspace = vault.get("workspace");
        if (!workspace) throw new Error("LICENSE_REQUIRED");
        const key = JSON.parse(vault.get("device-public")!),
          device = fingerprint(key);
        const proof = await new SignJWT({})
          .setProtectedHeader({ alg: "EdDSA", typ: "corestrum-device+jwt" })
          .setSubject(device)
          .setAudience(config.cloudOrigin + "/api/license/refresh")
          .setJti(randomUUID())
          .setIssuedAt()
          .setExpirationTime("60s")
          .sign(
            await importJWK(JSON.parse(vault.get("device-private")!), "EdDSA"),
          );
        const response = await fetch(
          config.cloudOrigin + "/api/license/refresh",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspace, device, proof }),
            redirect: "error",
            signal: AbortSignal.timeout(20000),
          },
        );
        if (!response.ok) throw new Error("LICENSE_REFRESH_UNAVAILABLE");
        const value = JSON.parse(await readBody(response, 16384));
        const checked = await verifyLicense(
          value.license,
          config.licensePublicKey,
          { device, environment: config.environment, major: PRODUCT.major },
        );
        if (checked.workspace !== workspace)
          throw new Error("WORKSPACE_MISMATCH");
        vault.set("license", value.license);
        license = checked;
        return json({ refreshed: true });
      }
      await entitle();
      const op = await openOperations();
      if (url.pathname === "/api/local/claude/status") return json(await claude.status(vault));
      if (url.pathname === "/api/local/claude/setup") return json({ command: await claude.setupCommand(vault) });
      if (url.pathname === "/api/local/claude/connect") {
        const result = await claude.connect(vault, b.model, b.confirmed);
        op.audit("provider.connected", "claude-code");
        return json(result);
      }
      if (url.pathname === "/api/local/claude/cancel") {
        claude.cancel();
        op.audit("provider.cancel_requested", "claude-code");
        return json({ requested: true });
      }
      if (url.pathname === "/api/local/provider") {
        const result = await saveProvider(
          vault,
          provider(b.provider),
          b.key,
          b.model,
        );
        op.audit("provider.connected", b.provider);
        return json(result);
      }
      if (url.pathname === "/api/local/provider/disconnect") {
        const p = provider(b.provider);
        if (p === "claude-code") claude.cancel();
        vault.remove("provider:" + p);
        op.audit("provider.disconnected", p);
        return json({ disconnected: true });
      }
      if (url.pathname === "/api/local/context") {
        if (typeof b.context !== "string" || b.context.length > 12000)
          throw new Error("INVALID_CONTEXT");
        op.saveContext(b.context);
        op.audit("business.context_updated", license!.workspace);
        return json({ saved: true });
      }
      if (url.pathname === "/api/local/draft") {
        if (
          !AGENTS.some((a) => a.id === b.agent) ||
          typeof b.prompt !== "string"
        )
          throw new Error("INVALID_REQUEST");
        return json(
          await op.run(
            b.agent as AgentId,
            provider(b.provider),
            b.prompt,
            undefined,
            b.specialists,
          ),
        );
      }
      if (url.pathname === "/api/local/automations") {
        return json(await op.create(b));
      }
      if (url.pathname === "/api/local/automations/toggle") {
        if (typeof b.id !== "string" || typeof b.enabled !== "boolean")
          throw new Error("INVALID_REQUEST");
        await op.toggle(b.id, b.enabled);
        return json({ saved: true });
      }
      if (url.pathname === "/api/local/report")
        return json(op.report(String(b.id)));
      if (url.pathname === "/api/local/backup/export") {
        const archive = await encryptBackup(op.exportBusiness(), b.password);
        await entitle();
        op.audit("backup.prepared", "business-data-only");
        return json(archive);
      }
      if (url.pathname === "/api/local/backup/restore") {
        if (b.confirmed !== true) throw Error("RESTORE_CONFIRM_REQUIRED");
        const contents = await decryptBackup(b.archive, b.password);
        await entitle();
        return json(op.restoreBusiness(contents, config.edition === "community" ? "community-import" : "same-workspace"));
      }
      if (url.pathname === "/api/local/evidence")
        return json({
          product: PRODUCT,
          workspace: license!.workspace,
          exportedAt: new Date().toISOString(),
          intact: op.verifyLedger(),
          events: op.ledger(),
          limitations: [
            "Local administrator can replace this database. Preserve independent signed exports.",
            "This evidence does not establish SOC 2 attestation.",
          ],
        });
      if (url.pathname === "/api/local/supabase/prepare") {
        bridgeEndpoint(b.project);
        if (
          vault.get("supabase-project") &&
          vault.get("supabase-project") !== b.project
        )
          throw new Error("PROJECT_ALREADY_BOUND");
        vault.set("supabase-project", b.project);
        if (!vault.has("bridge-encryption-key"))
          vault.set("bridge-encryption-key", randomBytes(32).toString("hex"));
        const result = await (
          await customer()
        ).prepare(b.accounts, hash(license!.workspace));
        op.audit("supabase.prepared", result.installation);
        return json(result);
      }
      if (url.pathname === "/api/local/supabase/verify")
        return json(
          await (
            await customer()
          ).verify(String(b.installation), hash(license!.workspace)),
        );
      if (url.pathname === "/api/local/supabase/read")
        return json(
          await (
            await customer()
          ).read(
            String(b.installation),
            String(b.resource),
            String(b.account),
            hash(license!.workspace),
          ),
        );
      if (url.pathname === "/api/local/supabase/revoke")
        return json(
          (await customer()).revoke(
            String(b.installation),
            hash(license!.workspace),
          ),
        );
      return json({ error: "NOT_FOUND" }, 404);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      const safe = /^[A-Z_]{3,70}$/.test(message)
        ? message
        : "REQUEST_UNAVAILABLE";
      return json(
        { error: safe },
        safe === "LOCAL_SESSION_REQUIRED" ? 401 : 403,
      );
    }
  }
  const tick = async () => {
    try {
      if (!vault.unlocked) {
        claude.cancel();
        bridge?.db.close();
        bridge = undefined;
        license = undefined;
        return;
      }
      if (operations) await operations.tick();
    } catch {
      /* Operations records failures without logging private content. */
    }
  };
  return {
    fetch: fetchHandler,
    bootstrap,
    tick,
    close() {
      claude.cancel();
      vault.lock();
      operations?.db.close();
      bridge?.db.close();
    },
  };
}

if (import.meta.main) {
  const data = resolve(
    process.env.CORESTRUM_DATA_DIR ?? join(homedir(), ".corestrum-community"),
  );
  // Community startup never discovers licensing configuration from the filesystem.
  // A licensed deployment must opt in with an explicit, validated path.
  const settingsPath = process.env.CORESTRUM_RELEASE_CONFIG;
  const release = settingsPath
    ? await validateDesktopRelease(JSON.parse(readFileSync(settingsPath, "utf8")))
    : { edition: "community" as const };
  const port = 4393;
  const app = localApp({
    data,
    origin: `http://127.0.0.1:${port}`,
    ...release,
    assets: resolve(process.env.CORESTRUM_ASSETS ?? "dist-corestrum"),
  });
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: BACKUP_MAX_BYTES + 8192,
    fetch: app.fetch,
  });
  writeFileSync(
    join(data, "launch-url.txt"),
    `http://127.0.0.1:${port}/#launch=${app.bootstrap}`,
    { mode: 0o600 },
  );
  console.log(
    "Corestrum is running locally. Open the private launch link in your Corestrum data folder. Never share that link.",
  );
  setInterval(() => void app.tick(), 30000);
}
