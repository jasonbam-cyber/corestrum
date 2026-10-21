import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import Stripe from "stripe";
import { Billing } from "../src/corestrum/cloud/billing";
import { cloudHandler } from "../src/corestrum/cloud/handler";
import { fingerprint } from "../src/corestrum/device";
import { verifyLicense } from "../src/corestrum/license";
import { grantComplimentary, revokeComplimentary } from "../src/corestrum/cloud/complimentary";
// Real isolated PostgreSQL; payment provider fixtures never contact Stripe or charge money.
const root = mkdtempSync(
  join(process.env.TEST_SCRATCH ?? tmpdir(), "corestrum-pg-"),
);
const socket = mkdtempSync(join(tmpdir(), "corestrum-pg-socket-"));
const bin = process.env.PG_BIN ?? "";
let started = false;
let db: postgres.Sql | undefined, restricted: postgres.Sql | undefined, operator: postgres.Sql | undefined;
const command = (name: string, args: string[]) => {
  const r = Bun.spawnSync([bin ? join(bin, name) : name, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode) throw Error(name + ": " + r.stderr.toString());
};
let assertions = 0;
const check = (v: unknown, message: string) => {
  assertions++;
  if (!v) throw Error(message);
};
const rejects = async (fn: () => Promise<unknown>, message: string) => {
  let denied = false;
  try {
    await fn();
  } catch {
    denied = true;
  }
  check(denied, message);
};
try {
  command("initdb", [
    "-D",
    join(root, "data"),
    "--auth=trust",
    "--username=corestrum_test_admin",
    "--no-locale",
  ]);
  command("pg_ctl", [
    "-D",
    join(root, "data"),
    "-l",
    join(root, "server.log"),
    "-o",
    `-k '${socket}' -c listen_addresses='' -p 55440`,
    "-w",
    "start",
  ]);
  started = true;
  db = postgres({
    host: socket,
    port: 55440,
    username: "corestrum_test_admin",
    database: "postgres",
    max: 2,
    onnotice: () => {},
  });
  const migrations = readdirSync("cloud/supabase/migrations").filter((x) => x.endsWith(".sql")).sort();
  for (const migration of migrations)
    await db.unsafe(readFileSync(join("cloud/supabase/migrations", migration), "utf8"));
  await db`ALTER ROLE corestrum_licensing LOGIN`;
  await db`ALTER ROLE corestrum_grants LOGIN`;
  operator = postgres({ host: socket, port: 55440, username: "corestrum_grants", database: "postgres", max: 2 });
  restricted = postgres({
    host: socket,
    port: 55440,
    username: "corestrum_licensing",
    database: "postgres",
    max: 5,
  });
  const sql = restricted;
  const secret = randomBytes(32).toString("hex"),
    stripeSdk = new Stripe("fixture-only-not-a-real-key"),
    sessions = new Map<string, any>(),
    subs = new Map<string, any>(),
    intents = new Map<string, any>();
  let priceLive = false, providerCalls = 0;
  const price = (id: string) => ({
    id,
    active: true,
    livemode: priceLive,
    currency: "usd",
    unit_amount:
      id === "price_monthly" ? 1000 : id === "price_annual" ? 7900 : 11900,
    recurring:
      id === "price_perpetual"
        ? null
        : { interval: id === "price_monthly" ? "month" : "year" },
  });
  const stripe = {
    webhooks: stripeSdk.webhooks,
    customers: { create: async () => { providerCalls++; return { id: "cus_" + randomUUID() }; } },
    prices: { retrieve: async (id: string) => { providerCalls++; return price(id); } },
    billingPortal: { sessions: { create: async () => { providerCalls++; return { url: "https://billing.stripe.com/fixture" }; } } },
    checkout: {
      sessions: {
        create: async (p: any) => {
          providerCalls++;
          const s = {
            id: "cs_" + randomUUID(),
            customer: p.customer,
            client_reference_id: p.client_reference_id,
            livemode: false,
            status: "open",
            payment_status: "unpaid",
            created: Math.floor(Date.now() / 1000),
            url: "https://checkout.stripe.com/c/pay/fixture",
            price: p.line_items[0].price,
          };
          sessions.set(s.id, s);
          return s;
        },
        retrieve: async (id: string) => { providerCalls++; return sessions.get(id); },
        expire: async (id: string) => {
          providerCalls++;
          sessions.get(id).status = "expired";
        },
        listLineItems: async (id: string) => ({
          data: [{ price: price(sessions.get(id).price), quantity: 1 }],
        }),
      },
    },
    subscriptions: { retrieve: async (id: string) => { providerCalls++; return subs.get(id); } },
    paymentIntents: { retrieve: async (id: string) => { providerCalls++; return intents.get(id); } },
    charges: {
      retrieve: async () => ({
        customer: (await billing.account("owner-a")).customer,
      }),
    },
  } as unknown as Stripe;
  const origin = "https://corestrum-staging.example";
  const billing = new Billing(sql, stripe, {
    origin,
    prices: {
      monthly: "price_monthly",
      annual: "price_annual",
      perpetual: "price_perpetual",
    },
    environment: "staging",
    webhookSecret: secret,
  });
  const a = await billing.account("owner-a"),
    b = await billing.account("owner-b");
  check(a.workspace !== b.workspace, "Customer workspaces must differ");
  await billing.checkout("owner-a", "monthly");
  let own = await billing.account("owner-a");
  check(own.state === "unpaid", "Checkout creation must not confer access");
  await billing.checkout("owner-a", "monthly");
  check(sessions.size === 1, "Repeated checkout must reuse session");
  await billing.checkout("owner-a", "annual");
  check(sessions.size === 2, "Different price must replace open checkout");
  own = await billing.account("owner-a");
  const session = sessions.get(own.checkout!);
  session.status = "complete";
  session.payment_status = "paid";
  session.subscription = "sub_fixture";
  subs.set("sub_fixture", {
    customer: own.customer,
    status: "active",
    latest_invoice: { status: "paid" },
    items: {
      data: [
        {
          price: { id: "price_annual" },
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
        },
      ],
    },
  });
  const event = async (
    type: string,
    customer: string,
    eventId = "evt_" + randomUUID(),
    live = false,
  ) => {
    const body = JSON.stringify({
      id: eventId,
      object: "event",
      type,
      livemode: live,
      data: { object: { customer, charge: "ch_fixture" } },
    });
    const signature = await stripeSdk.webhooks.generateTestHeaderStringAsync({
      payload: body,
      secret,
    });
    return billing.webhook(body, signature);
  };
  await rejects(
    () => billing.webhook("{}", "bad-signature"),
    "Unsigned webhook accepted",
  );
  await rejects(
    () => event("invoice.paid", own.customer!, undefined, true),
    "Live payment accepted in staging",
  );
  const eventId = "evt_" + randomUUID();
  await Promise.all([
    event("invoice.paid", own.customer!, eventId),
    event("invoice.paid", own.customer!, eventId),
  ]);
  check(
    (await sql`SELECT id FROM corestrum_private.events WHERE id=${eventId}`)
      .length === 1,
    "Concurrent webhook dedupe failed",
  );
  own = await billing.account("owner-a");
  check(
    own.state === "active" && Number.isSafeInteger(own.updates_until),
    "Paid subscription or bigint normalization failed",
  );
  check(
    (await billing.account("owner-b")).state === "unpaid",
    "Payment leaked to second customer",
  );
  const signing = await generateKeyPair("EdDSA", { extractable: true }),
    publicKey = await exportJWK(signing.publicKey),
    privateKey = await exportJWK(signing.privateKey);
  const handler = cloudHandler(
    {
      origin,
      environment: "staging",
      publishableKey: "fixture",
      signingKey: privateKey,
      keyId: "test",
    },
    billing,
    async (req, sensitive) => {
      const subject = req.headers.get("x-test-subject");
      if (!subject) throw Error("SIGN_IN_REQUIRED");
      if (sensitive && req.headers.get("x-test-mfa") !== "fresh")
        throw Error("MFA_REQUIRED");
      return { subject, session: "fixture" };
    },
  );
  const send = (path: string, body: any, subject = "owner-a", mfa = "fresh") =>
    handler(
      new Request(origin + path, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-test-subject": subject,
          "x-test-mfa": mfa,
        },
        body: JSON.stringify(body),
      }),
    );
  const device = async (
    path = "/api/license/activate",
    old?: Awaited<ReturnType<typeof generateKeyPair>>,
  ) => {
    const keys = old ?? (await generateKeyPair("EdDSA", { extractable: true })),
      pub = await exportJWK(keys.publicKey),
      id = fingerprint(pub);
    return {
      keys,
      body: {
        publicKey: pub,
        device: id,
        proof: await new SignJWT({})
          .setProtectedHeader({ alg: "EdDSA", typ: "corestrum-device+jwt" })
          .setSubject(id)
          .setAudience(origin + path)
          .setJti(randomUUID())
          .setIssuedAt()
          .setExpirationTime("60s")
          .sign(keys.privateKey),
      },
    };
  };
  const d = await device();
  const mfa = await send("/api/license/activate", d.body, "owner-a", "stale");
  check(
    mfa.status === 403 && !!(await mfa.json()).clerk_error,
    "Missing reverification hint",
  );
  check(
    (await send("/api/license/activate", d.body, "owner-b")).status === 403,
    "Unpaid customer activated",
  );
  const activation = await send("/api/license/activate", d.body);
  check(activation.status === 200, "Paid activation failed");
  const issued = await activation.json();
  const storedKey = (await sql`SELECT public_key FROM corestrum_private.devices WHERE subject='owner-a' AND device=${d.body.device}`)[0]!.public_key;
  check(typeof storedKey === "object" && storedKey.kty === "OKP", "Public JWK stored as a JSON string instead of an object");
  const paidRefreshProof = await device("/api/license/refresh", d.keys);
  check((await send("/api/license/refresh", { workspace: a.workspace, device: d.body.device, proof: paidRefreshProof.body.proof })).status === 200, "Active paid device could not refresh from stored public key");
  check(
    (
      await verifyLicense(issued.license, publicKey, {
        device: d.body.device,
        environment: "staging",
        major: 1,
      })
    ).workspace === a.workspace,
    "License binding incorrect",
  );
  check(
    (await send("/api/license/activate", d.body)).status !== 200,
    "Activation replay accepted",
  );
  check(
    (await send("/api/license/activate", (await device()).body)).status === 200,
    "Second computer activation failed",
  );
  check(
    (await send("/api/license/activate", (await device()).body)).status === 403,
    "Third active computer admitted",
  );
  check(
    (await send("/api/license/revoke", { device: d.body.device }, "owner-b"))
      .status !== 200,
    "Foreign owner revoked device",
  );
  check(
    (await send("/api/license/revoke", { device: d.body.device })).status ===
      200,
    "Own revocation failed",
  );
  const refresh = await device("/api/license/refresh", d.keys);
  check(
    (
      await send("/api/license/refresh", {
        workspace: a.workspace,
        device: d.body.device,
        proof: refresh.body.proof,
      })
    ).status === 403,
    "Revoked device refreshed",
  );
  await event("charge.refunded", own.customer!);
  check(
    (await billing.account("owner-a")).state === "suspended",
    "Refund did not suspend subscription",
  );
  await event("invoice.paid", own.customer!);
  check(
    (await billing.account("owner-a")).state === "suspended",
    "Delayed paid event removed refund hold",
  );
  await rejects(
    () => billing.checkout("owner-a", "monthly"),
    "Refund hold allowed another checkout",
  );
  priceLive = true;
  await rejects(
    () => billing.checkout("owner-b", "monthly"),
    "Live price accepted in staging",
  );
  priceLive = false;
  await billing.checkout("owner-b", "perpetual");
  const second = await billing.account("owner-b"),
    s = sessions.get(second.checkout!);
  s.status = "complete";
  s.payment_status = "paid";
  s.payment_intent = "pi_fixture";
  intents.set("pi_fixture", {
    customer: second.customer,
    status: "succeeded",
    latest_charge: {
      paid: true,
      refunded: false,
      disputed: false,
      amount_refunded: 0,
    },
  });
  await event("checkout.session.completed", second.customer!);
  check(
    (await billing.account("owner-b")).state === "active",
    "Perpetual activation failed",
  );
  check(
    (await send("/api/license/activate", (await device()).body, "owner-b"))
      .status === 200,
    "Perpetual license issue failed",
  );
  // Complimentary access uses separate append-only operator authority, not payment fiction.
  const pilot = await billing.account("pilot-c");
  const foreign = await billing.account("pilot-d");
  const grantRequest = { subject: pilot.subject, workspace: pilot.workspace, environment: "staging" as const, approvalReference: "fixture-owner-approval", reason: "Synthetic lifetime pilot" };
  const callsBefore = providerCalls;
  await rejects(() => grantComplimentary(sql, grantRequest), "Runtime granted complimentary access");
  await rejects(() => grantComplimentary(operator!, { ...grantRequest, workspace: foreign.workspace }), "Foreign workspace grant accepted");
  await rejects(() => grantComplimentary(operator!, { ...grantRequest, subject: a.subject, workspace: a.workspace }), "Billing hold converted into free access");
  await rejects(() => grantComplimentary(operator!, { ...grantRequest, subject: second.subject, workspace: second.workspace }), "Paid account converted with a subscription/payment still attached");
  const grant = await grantComplimentary(operator!, grantRequest);
  check(grant.created, "Operator grant not created");
  const duplicate = await grantComplimentary(operator!, grantRequest);
  check(!duplicate.created && duplicate.id === grant.id, "Grant retry duplicated authority");
  const raw = (await db`SELECT * FROM corestrum_private.complimentary_grants WHERE id=${grant.id}`)[0]!;
  check(raw.granted_by === "corestrum_grants" && raw.approval_reference === grantRequest.approvalReference && raw.granted_at, "Missing immutable operator audit provenance");
  await rejects(() => operator!`UPDATE corestrum_private.complimentary_grants SET reason='rewritten'`, "Grant history is mutable");
  await rejects(() => operator!`DELETE FROM corestrum_private.complimentary_grants`, "Grant history is deletable");
  await rejects(() => operator!`UPDATE corestrum_private.accounts SET billing_hold=false`, "Grant operator can modify billing");
  await rejects(() => operator!`INSERT INTO corestrum_private.complimentary_grants(subject,workspace,environment,approval_reference,reason,granted_by) VALUES(${foreign.subject},${foreign.workspace},'staging','fake-approval','fake-reason','forged')`, "Grant operator forged actor");
  await rejects(() => sql`SET ROLE corestrum_grants`, "Runtime escalated to grant operator");
  const accountResponse = await handler(new Request(origin + "/api/account", { headers: { "x-test-subject": pilot.subject } }));
  const accountView = await accountResponse.json();
  check(accountView.plan === "complimentary" && accountView.state === "active" && accountView.updatesUntil === null, "Complimentary account not exposed without checkout");
  check((await billing.account(pilot.subject)).state === "unpaid" && !(await billing.account(pilot.subject)).customer, "Grant fabricated payment/customer state");
  check((await send("/api/checkout", { plan: "monthly" }, pilot.subject)).status === 403, "Complimentary customer allowed into checkout");
  check((await send("/api/billing/portal", {}, pilot.subject)).status === 403, "Complimentary customer allowed into billing portal");
  const pd = await device();
  check((await send("/api/license/activate", pd.body, pilot.subject, "stale")).status === 403, "Complimentary access bypassed MFA");
  check((await send("/api/license/activate", { ...pd.body, grantId: grant.id }, foreign.subject)).status === 403, "Customer supplied grant bypassed authentication");
  check((await send("/api/license/activate", pd.body, foreign.subject)).status === 403, "Grant leaked to foreign customer");
  const pr = await send("/api/license/activate", pd.body, pilot.subject);
  check(pr.status === 200, "Complimentary device activation failed");
  const complimentaryToken = (await pr.json()).license;
  const pl = await verifyLicense(complimentaryToken, publicKey, { device: pd.body.device, environment: "staging", major: 99 }, Math.floor(Date.now()/1000) + 10 * 365 * 86400);
  check(pl.workspace === pilot.workspace && pl.plan === "complimentary" && pl.grantId === grant.id && pl.expires === null && pl.updatesUntil === null, "Lifetime/future-version grant binding failed");
  const pd2 = await device();
  check((await send("/api/license/activate", pd2.body, pilot.subject)).status === 200, "Second complimentary device failed");
  check((await send("/api/license/activate", (await device()).body, pilot.subject)).status === 403, "Complimentary device limit bypassed");
  const freshPilotProof = await device("/api/license/refresh", pd.keys);
  check((await send("/api/license/refresh", { workspace: pilot.workspace, device: pd.body.device, proof: freshPilotProof.body.proof })).status === 200, "Complimentary refresh without a billing customer failed");
  check((await send("/api/license/revoke", { device: pd.body.device }, foreign.subject)).status === 404, "Foreign customer revocation did not fail as not found");
  check((await db`SELECT revoked FROM corestrum_private.devices WHERE subject=${pilot.subject} AND device=${pd.body.device}`)[0]?.revoked === false, "Denied foreign revocation mutated the owner's device");
  check((await send("/api/license/revoke", { device: pd.body.device }, pilot.subject)).status === 200, "Complimentary owner could not revoke device");
  const revokedProof = await device("/api/license/refresh", pd.keys);
  check((await send("/api/license/refresh", { workspace: pilot.workspace, device: pd.body.device, proof: revokedProof.body.proof })).status === 403, "Revoked complimentary device refreshed");
  const productionOnly = await grantComplimentary(operator!, { ...grantRequest, subject: foreign.subject, workspace: foreign.workspace, environment: "production" });
  check(!!productionOnly.id && await billing.complimentary(foreign) === null, "Production grant admitted in staging");
  await rejects(() => revokeComplimentary(sql, grant.id, "fixture-denied", "Runtime must not revoke grants"), "Runtime revoked a grant");
  await revokeComplimentary(operator!, grant.id, "fixture-revocation", "Synthetic revocation test");
  const remainingProof = await device("/api/license/refresh", pd2.keys);
  check((await send("/api/license/refresh", { workspace: pilot.workspace, device: pd2.body.device, proof: remainingProof.body.proof })).status === 403, "Revoked grant issued new license");
  await rejects(() => grantComplimentary(operator!, grantRequest), "Revoked grant was silently reactivated");
  await rejects(() => operator!`DELETE FROM corestrum_private.complimentary_revocations`, "Revocation history is deletable");
  check((await verifyLicense(complimentaryToken, publicKey, { device: pd.body.device, environment: "staging", major: 10 })).plan === "complimentary", "Offline permanent license semantics changed; no immediate remote erasure is claimed");
  check(providerCalls === callsBefore, "Complimentary flow touched payment provider");
  const raceAccount = await billing.account("pilot-checkout-race");
  const raceResults = await Promise.allSettled([
    grantComplimentary(operator!, { ...grantRequest, subject: raceAccount.subject, workspace: raceAccount.workspace }),
    billing.checkout(raceAccount.subject, "monthly"),
  ]);
  check(raceResults.filter((r) => r.status === "fulfilled").length === 1, "Concurrent grant and checkout both succeeded or both failed");
  const raceCurrent = await billing.account(raceAccount.subject);
  const raceGrant = await billing.complimentary(raceCurrent);
  check(raceGrant ? !raceCurrent.customer && !raceCurrent.checkout : !!raceCurrent.customer && !!raceCurrent.checkout, "Checkout and complimentary grant overlapped");
  const role = (
    await db`SELECT * FROM pg_roles WHERE rolname='corestrum_licensing'`
  )[0];
  check(
    !role.rolsuper && !role.rolbypassrls && !role.rolinherit,
    "Licensing role overprivileged",
  );
  await rejects(
    () => sql`DELETE FROM corestrum_private.audit`,
    "Audit deletion allowed",
  );
  await rejects(
    () => sql`UPDATE corestrum_private.audit SET action='changed'`,
    "Audit mutation allowed",
  );
  await rejects(
    () => sql`SET ROLE corestrum_test_admin`,
    "Role escalation allowed",
  );
  const tables =
    await db`SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='corestrum_private' AND c.relkind='r'`;
  check(
    tables.length === 7 &&
      tables.every((t) => t.relrowsecurity && t.relforcerowsecurity),
    "Missing forced RLS",
  );
  console.log(
    JSON.stringify({
      ok: true,
      assertions,
      database: "disposable PostgreSQL",
      stripe: "signed fixtures, no provider requests",
      clerk: "injected identities, not hosted qualification",
      migrations,
      complimentary: "operator-only append history, no payment calls, lifetime version-independent license",
    }),
  );
} finally {
  await operator?.end({ timeout: 2 });
  await restricted?.end({ timeout: 2 });
  await db?.end({ timeout: 2 });
  if (started)
    command("pg_ctl", ["-D", join(root, "data"), "-m", "fast", "-w", "stop"]);
  rmSync(root, { recursive: true, force: true });
  rmSync(socket, { recursive: true, force: true });
}
