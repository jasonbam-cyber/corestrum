import {
  audit,
  Denied,
  equal,
  fields,
  hash,
  httpsOrigin,
  uuid,
} from "./common";
import { IdentityStore, type Principal } from "./identity";
import type { IdentityProvider } from "./oidc";
import { page, portal, portalCss } from "./portal";

const cookie = (name: string, value: string, age: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function readCookie(req: Request, name: string) {
  const values = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(name + "="));
  if (values.length !== 1) return "";
  const value = values[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : "";
}
export function productionHandler(options: {
  origin: string;
  identity: IdentityStore;
  provider: IdentityProvider;
  call: (
    principal: Principal,
    command: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  const origin = httpsOrigin(options.origin),
    store = options.identity;
  const security = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000",
    "content-security-policy":
      "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
  // Peer addresses come only from the server transport, never forwarded headers.
  // Unauthenticated clients and authenticated subjects have separate budgets.
  const anonymous = new Map<string, { at: number; count: number }>();
  const subjects = new Map<string, { at: number; count: number }>();
  const limit = (buckets: typeof anonymous, key: string, maximum: number) => {
    const now = Date.now();
    for (const [k, value] of buckets) if (now - value.at >= 60_000) buckets.delete(k);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 4096) throw new Denied("RATE_LIMITED", 429);
      bucket = { at: now, count: 0 };
      buckets.set(key, bucket);
    }
    if (++bucket.count > maximum) throw new Denied("RATE_LIMITED", 429);
  };
  let denialWindow = Date.now(), denialWrites = 0;
  return async (req: Request, peerAddress = "unavailable"): Promise<Response> => {
    let auditActor = "anonymous";
    const respond = (
      body: BodyInit | null,
      status = 200,
      headers: HeadersInit = {},
    ) =>
      new Response(body, {
        status,
        headers: { ...security, ...Object.fromEntries(new Headers(headers)) },
      });
    const html = (body: string, status = 200) =>
      respond(body, status, { "content-type": "text/html; charset=utf-8" });
    const json = (body: unknown, status = 200) =>
      respond(JSON.stringify(body), status, {
        "content-type": "application/json",
      });
    try {
      const url = new URL(req.url);
      if (
        url.origin !== origin ||
        (req.headers.has("host") &&
          req.headers.get("host") !== new URL(origin).host)
      )
        throw new Denied("ORIGIN_REJECTED");
      if (req.method !== "GET" && req.method !== "POST")
        throw new Denied("NOT_FOUND", 404);
      // Cross-site top-level GET is required for the OIDC redirect, never for mutations.
      if (
        req.method === "POST" &&
        (req.headers.get("origin") !== origin ||
          req.headers.get("sec-fetch-site") === "cross-site")
      )
        throw new Denied("ORIGIN_REJECTED");
      if (url.pathname === "/portal.css" && req.method === "GET")
        return respond(portalCss, 200, { "content-type": "text/css" });
      if (url.pathname === "/health" && req.method === "GET")
        return json({
          ok: true,
          mode: "production-auth",
          liveCustomerReady: false,
        });
      const id = readCookie(req, "__Host-wp_session");
      // Only a valid local session may bypass the anonymous budget. Random or
      // attacker-supplied cookies cannot create authenticated rate-limit buckets.
      let authenticated: ReturnType<IdentityStore["session"]> | undefined;
      if (id) { try { authenticated = store.session(id); } catch {} }
      if (authenticated) {
        auditActor = hash(authenticated.issuer + "|" + authenticated.subject);
        limit(subjects, auditActor, 600);
      } else limit(anonymous, hash(peerAddress), 60);
      if (url.pathname === "/api/demo-session")
        throw new Denied("NOT_FOUND", 404);
      if (url.pathname === "/auth/login" && req.method === "GET") {
        const { url: location, transaction } = await options.provider.begin();
        const id = store.login(transaction);
        return respond(null, 302, {
          location,
          "set-cookie": cookie("__Host-wp_login", id, 300),
        });
      }
      if (url.pathname === "/auth/callback" && req.method === "GET") {
        const id = readCookie(req, "__Host-wp_login");
        if (!id) throw new Denied("LOGIN_REQUIRED", 401);
        const t = store.consumeLogin(id);
        const identity = await options.provider.complete(url, t);
        if (!(await options.provider.active(identity)))
          throw new Denied("IDENTITY_REVOKED", 401);
        const old = readCookie(req, "__Host-wp_session");
        if (old) store.revoke(old);
        const session = store.create(identity);
        const response = respond(null, 303, { location: "/" });
        response.headers.append(
          "set-cookie",
          cookie("__Host-wp_session", session.id, 3600),
        );
        response.headers.append("set-cookie", cookie("__Host-wp_login", "", 0));
        return response;
      }
      if (!id && url.pathname === "/" && req.method === "GET")
        return html(portal());
      const s = store.session(id);
      auditActor = hash(s.issuer + "|" + s.subject);
      if (!(await options.provider.active(s))) {
        store.revoke(id);
        throw new Denied("IDENTITY_REVOKED", 401);
      }
      // Re-load local membership after the network check to close a revocation race.
      const fresh = store.session(id);
      store.touch(id);
      const members = store.members(fresh);
      if (req.method === "GET") {
        if (url.pathname === "/") {
          const before = fresh.org ? store.principal(fresh) : undefined;
          const connection = before
            ? await options.call(before, "snapshot", {})
            : undefined;
          if (
            before &&
            JSON.stringify(store.principal(store.session(id))) !==
              JSON.stringify(before)
          )
            throw new Denied("MEMBERSHIP_CHANGED");
          return html(portal(fresh, members, undefined, connection as any));
        }
        if (url.pathname === "/api/session")
          return json({ csrf: s.csrf, members, selected: fresh.org });
        throw new Denied("NOT_FOUND", 404);
      }
      const contentType = req.headers.get("content-type") ?? "";
      const text = await req.text();
      if (Buffer.byteLength(text) > 8192)
        throw new Denied("BODY_TOO_LARGE", 413);
      let body: Record<string, unknown>;
      if (contentType === "application/json") body = JSON.parse(text);
      else if (contentType === "application/x-www-form-urlencoded") {
        const params = new URLSearchParams(text);
        if (new Set(params.keys()).size !== [...params.keys()].length)
          throw new Denied("DUPLICATE_FIELD", 400);
        body = Object.fromEntries(params);
      } else throw new Denied("INVALID_CONTENT_TYPE", 400);
      fields(body, [
        "csrf",
        "org",
        "accounts",
        "installation",
        "resource",
        "account",
      ]);
      if (typeof body.csrf !== "string" || !equal(body.csrf, fresh.csrf))
        throw new Denied("CSRF_REJECTED");
      if (url.pathname === "/auth/logout") {
        fields(body, ["csrf"]);
        store.revoke(id);
        return respond(null, 303, {
          location: "/",
          "set-cookie": cookie("__Host-wp_session", "", 0),
        });
      }
      if (url.pathname === "/auth/customer") {
        fields(body, ["csrf", "org"]);
        if (!uuid(body.org)) throw new Denied("NOT_FOUND", 404);
        store.select(id, body.org);
        return respond(null, 303, { location: "/" });
      }
      const command = url.pathname.match(
        /^\/onboarding\/(snapshot|prepare|verify|manifest|read|revoke)$/,
      )?.[1];
      if (!command) throw new Denied("NOT_FOUND", 404);
      const { csrf, ...input } = body;
      const commandFields: Record<string, string[]> = {
        snapshot: [],
        prepare: ["accounts"],
        verify: ["installation"],
        manifest: ["installation"],
        read: ["installation", "resource", "account"],
        revoke: ["installation"],
      };
      fields(input, commandFields[command]);
      if (command === "prepare" && typeof input.accounts === "string")
        input.accounts = input.accounts.split(",").map((x) => x.trim());
      const principal = store.principal(store.session(id));
      const result = await options.call(principal, command, input);
      // Never deliver an in-flight result after membership revocation/customer switching.
      const after = store.principal(store.session(id));
      if (JSON.stringify(after) !== JSON.stringify(principal))
        throw new Denied("MEMBERSHIP_CHANGED");
      if (contentType === "application/json") return json(result);
      const connection = await options.call(after, "snapshot", {});
      if (
        JSON.stringify(store.principal(store.session(id))) !==
        JSON.stringify(after)
      )
        throw new Denied("MEMBERSHIP_CHANGED");
      return html(portal(fresh, members, result, connection as any));
    } catch (e) {
      const fault = e instanceof Denied ? e : new Denied("REQUEST_FAILED", 503);
      // Denials are sampled, at most 16 persistent rows/minute per process.
      // A rejected request must not cause unbounded synchronous audit writes.
      if (Date.now() - denialWindow >= 60_000) { denialWindow = Date.now(); denialWrites = 0; }
      if (denialWrites++ < 16) audit(store.db, auditActor, "request.denied_sample", fault.code);
      return req.headers.get("accept")?.includes("text/html")
        ? html(
            page(
              "Request could not finish",
              `<h1>Request could not finish.</h1><p>${fault.code}</p><a href="/">Return to your workspace</a>`,
            ),
            fault.status,
          )
        : json({ error: fault.code }, fault.status);
    }
  };
}
