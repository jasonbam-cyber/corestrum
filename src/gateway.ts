import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import {
  customers,
  Fault,
  type Org,
  type Principal,
  type Role,
} from "./contracts";

type Session = {
  principal: Principal;
  csrf: string;
  expires: number;
  count: number;
  window: number;
};
const opaque = () => randomBytes(32).toString("hex");
export async function startGateway(options: {
  root: string;
  port: number;
  mode: string;
  dist?: string;
}) {
  if (options.mode !== "synthetic" || process.env.NODE_ENV === "production")
    throw new Error(
      "SYNTHETIC_ONLY: production identity, KMS and deployment controls are not implemented.",
    );
  process.umask(0o077);
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  chmodSync(options.root, 0o700);
  const lock = join(options.root, ".supervisor-lock");
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  const socketRoot = mkdtempSync("/tmp/saas-ops-");
  const workers = new Map<
    Org,
    { socket: string; token: string; process: ReturnType<typeof Bun.spawn> }
  >();
  const sessions = new Map<string, Session>();
  let closing = false;
  const cleanup = async () => {
    if (closing) return;
    closing = true;
    sessions.clear();
    for (const w of workers.values()) w.process.kill("SIGTERM");
    await Promise.all([...workers.values()].map((w) => w.process.exited));
    rmSync(socketRoot, { recursive: true, force: true });
    rmSync(lock, { force: true });
  };
  async function call(
    principal: Principal,
    command: string,
    input: Record<string, unknown> = {},
  ) {
    const w = workers.get(principal.org)!;
    try {
      const response = await fetch("http://runtime/command", {
        unix: w.socket,
        method: "POST",
        headers: {
          authorization: `Bearer ${w.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ principal, command, input }),
        signal: AbortSignal.timeout(5000),
      });
      const value = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Fault(String(value.error), response.status);
      return value;
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault("RUNTIME_UNAVAILABLE", 503);
    }
  }
  try {
    for (const org of Object.keys(customers) as Org[]) {
      const dir = join(options.root, org);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const socket = join(socketRoot, `${org}.sock`),
        token = opaque();
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "runtime/worker.ts"),
        ],
        {
          env: {
            PROTOTYPE_MODE: "synthetic",
            NODE_ENV: "test",
            CUSTOMER_ORG: org,
            CUSTOMER_DB: join(dir, "runtime.sqlite"),
            RUNTIME_SOCKET: socket,
            RUNTIME_TOKEN: token,
          },
          stdin: "pipe",
          stdout: "ignore",
          stderr: "inherit",
        },
      );
      workers.set(org, { socket, token, process: child });
      for (let n = 0; n < 100 && !existsSync(socket); n++) {
        if (child.exitCode !== null) throw new Error("RUNTIME_START_FAILED");
        await Bun.sleep(20);
      }
      await call({ org, actor: `owner-${org}`, role: "owner" }, "snapshot");
    }
    let origin = "";
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    };
    const json = (
      body: unknown,
      status = 200,
      extra: Record<string, string> = {},
    ) => Response.json(body, { status, headers: { ...headers, ...extra } });
    let loginWindow = Date.now(),
      loginCount = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
      maxRequestBodySize: 16384,
      async fetch(req) {
        const url = new URL(req.url);
        try {
          if (
            url.origin !== origin ||
            req.headers.get("host") !== new URL(origin).host ||
            (req.headers.has("origin") &&
              req.headers.get("origin") !== origin) ||
            req.headers.get("sec-fetch-site") === "cross-site"
          )
            throw new Fault("ORIGIN_REJECTED");
          const mutates = req.method !== "GET";
          if (mutates && req.headers.get("origin") !== origin)
            throw new Fault("ORIGIN_REQUIRED");
          if (url.pathname === "/api/health" && req.method === "GET")
            return json({ ok: true, synthetic: true, mode: "local-prototype" });
          const parseBody = async () => {
            if (req.headers.get("content-type") !== "application/json")
              throw new Fault("JSON_REQUIRED", 400);
            const text = await req.text();
            if (text.length > 16384) throw new Fault("BODY_TOO_LARGE", 413);
            try {
              const v = JSON.parse(text);
              if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
              return v as Record<string, unknown>;
            } catch {
              throw new Fault("INVALID_JSON", 400);
            }
          };
          if (url.pathname === "/api/demo-session" && req.method === "POST") {
            if (Date.now() - loginWindow > 60000) {
              loginWindow = Date.now();
              loginCount = 0;
            }
            if (++loginCount > 60) throw new Fault("RATE_LIMITED", 429);
            const body = await parseBody();
            if (
              Object.keys(body).some(
                (k) => !["customer", "role"].includes(k),
              ) ||
              !Object.hasOwn(customers, String(body.customer)) ||
              !["owner", "viewer"].includes(String(body.role))
            )
              throw new Fault("INVALID_INPUT", 400);
            const old = req.headers
              .get("cookie")
              ?.match(/(?:^|;\s*)wp_session=([a-f0-9]{64})(?:;|$)/)?.[1];
            if (old) sessions.delete(old);
            for (const [key, s] of sessions)
              if (s.expires < Date.now()) sessions.delete(key);
            const id = opaque(),
              csrf = opaque(),
              org = body.customer as Org,
              role = body.role as Role;
            sessions.set(id, {
              principal: { org, role, actor: `${role}-${org}` },
              csrf,
              expires: Date.now() + 3600000,
              count: 0,
              window: Date.now(),
            });
            return json({ csrf, org, role, synthetic: true }, 200, {
              "set-cookie": `wp_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
            });
          }
          if (url.pathname.startsWith("/api/")) {
            const token = req.headers
              .get("cookie")
              ?.match(/(?:^|;\s*)wp_session=([a-f0-9]{64})(?:;|$)/)?.[1];
            const session = token ? sessions.get(token) : null;
            if (!session || session.expires < Date.now())
              throw new Fault("SESSION_REQUIRED", 401);
            if (Date.now() - session.window > 60000) {
              session.count = 0;
              session.window = Date.now();
            }
            if (++session.count > 120) throw new Fault("RATE_LIMITED", 429);
            if (mutates && req.headers.get("x-csrf-token") !== session.csrf)
              throw new Fault("CSRF_REJECTED");
            if (url.pathname === "/api/session" && req.method === "GET")
              return json({ ...session.principal, csrf: session.csrf });
            if (url.pathname === "/api/snapshot" && req.method === "GET")
              return json(await call(session.principal, "snapshot"));
            if (url.pathname === "/api/audit-export" && req.method === "GET")
              return json(await call(session.principal, "export"), 200, {
                "content-disposition": `attachment; filename="${session.principal.org}-audit.json"`,
              });
            if (url.pathname === "/api/command" && req.method === "POST") {
              const body = await parseBody();
              if (
                Object.keys(body).some(
                  (k) => !["command", "input"].includes(k),
                ) ||
                typeof body.command !== "string" ||
                !body.input ||
                typeof body.input !== "object" ||
                Array.isArray(body.input)
              )
                throw new Fault("INVALID_INPUT", 400);
              return json(
                await call(
                  session.principal,
                  body.command,
                  body.input as Record<string, unknown>,
                ),
              );
            }
            throw new Fault("NOT_FOUND", 404);
          }
          if (req.method !== "GET") throw new Fault("NOT_FOUND", 404);
          const path =
            url.pathname === "/" ? "index.html" : url.pathname.slice(1);
          // Static allowlist; never resolve paths into the runtime store or source tree.
          if (
            options.dist &&
            (path === "index.html" || /^assets\/[a-zA-Z0-9_.-]+$/.test(path))
          ) {
            const f = Bun.file(join(options.dist, path));
            if (await f.exists()) return new Response(f, { headers });
          }
          throw new Fault("NOT_FOUND", 404);
        } catch (e) {
          return json(
            { error: e instanceof Fault ? e.code : "SERVICE_UNAVAILABLE" },
            e instanceof Fault ? e.status : 503,
          );
        }
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    return {
      origin,
      pids: Object.fromEntries(
        [...workers].map(([org, w]) => [org, w.process.pid]),
      ),
      async stop() {
        server.stop(true);
        await cleanup();
      },
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
