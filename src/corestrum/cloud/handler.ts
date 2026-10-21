import { reverificationErrorResponse } from "@clerk/backend/internal";

import type { JWK } from "jose";
import { fingerprint, checkDeviceProof } from "../device";
import { readBody } from "../http";
import { signLicense, type License } from "../license";
import { PRODUCT, isPlan } from "../catalog";
import type { Billing, Account } from "./billing";
export type CloudConfig = {
  origin: string;
  environment: License["environment"];
  publishableKey: string;
  signingKey: JWK;
  keyId: string;
  downloadUrl?: string;
};
type Identity = (
  request: Request,
  sensitive?: boolean,
) => Promise<{ subject: string; session: string }>;
export function cloudHandler(
  config: CloudConfig,
  billing: Billing,
  identity: Identity,
) {
  const json = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  const issue = async (a: Account, device: string, db: any) => {
    const now = Math.floor(Date.now() / 1000);
    const grantId = await billing.complimentary(a, db);
    if (grantId && !a.billing_hold) {
      const license: License = {
        id: a.workspace, workspace: a.workspace, device,
        plan: "complimentary", major: null, issued: now,
        expires: null, updatesUntil: null, grantId,
        environment: config.environment,
      };
      await billing.audit(a.subject, "license.complimentary_issued", grantId, db);
      return { license: await signLicense(license, config.signingKey, config.keyId) };
    }
    if (
      a.state !== "active" ||
      !a.plan ||
      !a.updates_until ||
      (a.plan !== "perpetual" && (!a.paid_until || a.paid_until <= now))
    )
      throw new Error("PAYMENT_REQUIRED");
    const license: License = {
      id: a.workspace,
      workspace: a.workspace,
      device,
      plan: a.plan,
      major: PRODUCT.major,
      issued: now,
      expires:
        a.plan === "perpetual"
          ? null
          : Math.min(now + 7 * 86400, a.paid_until!),
      updatesUntil: Number(a.updates_until),
      environment: config.environment,
    };
    return {
      license: await signLicense(license, config.signingKey, config.keyId),
    };
  };
  return async (request: Request) => {
    try {
      const url = new URL(request.url);
      if (url.origin !== config.origin) throw new Error("ORIGIN_REJECTED");
      if (request.method === "GET" && url.pathname === "/api/config")
        return json({
          mode: "cloud",
          product: PRODUCT,
          environment: config.environment,
          publishableKey: config.publishableKey,
          checkoutReady: true,
          downloadUrl: config.downloadUrl ?? null,
        });
      if (request.method === "POST" && url.pathname === "/api/stripe/webhook") {
        const body = await readBody(request, 262144);
        if (Buffer.byteLength(body) > 262144) throw new Error("BODY_TOO_LARGE");
        return json(
          await billing.webhook(
            body,
            request.headers.get("stripe-signature") ?? "",
          ),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/account") {
        const { subject } = await identity(request);
        const a = await billing.account(subject);
        const complimentary = !a.billing_hold && Boolean(await billing.complimentary(a));
        return json({
          workspace: a.workspace,
          plan: complimentary ? "complimentary" : a.plan,
          state: complimentary ? "active" : a.state,
          paidUntil: a.paid_until,
          updatesUntil: complimentary || a.updates_until === null ? null : Number(a.updates_until),
          devices:
            await billing.sql`SELECT device,activated_at,revoked FROM corestrum_private.devices WHERE subject=${subject}`,
        });
      }
      if (
        request.method !== "POST" ||
        !request.headers.get("content-type")?.startsWith("application/json")
      )
        return json({ error: "NOT_FOUND" }, 404);
      const text = await readBody(request, 16384);
      if (text.length > 16384) throw new Error("BODY_TOO_LARGE");
      const body = JSON.parse(text);
      if (url.pathname === "/api/license/refresh") {
        if (
          Object.keys(body).some(
            (k) => !["workspace", "device", "proof"].includes(k),
          )
        )
          throw new Error("INVALID_REQUEST");
        const row = (
          await billing.sql`SELECT a.subject,d.public_key FROM corestrum_private.accounts a JOIN corestrum_private.devices d ON d.subject=a.subject WHERE a.workspace=${body.workspace}::uuid AND d.device=${body.device} AND NOT d.revoked`
        )[0];
        if (!row) throw new Error("DEVICE_REVOKED");
        const nonce = await checkDeviceProof(
          body.proof,
          row.public_key,
          body.device,
          config.origin + "/api/license/refresh",
        );
        await billing.sql`INSERT INTO corestrum_private.nonces(nonce,expires_at) VALUES(${nonce}::uuid,now()+interval '60 seconds')`;
        let a = await billing.account(row.subject);
        if (a.customer) await billing.reconcile(a.customer);
        return json(
          await billing.sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${row.subject},0))`;
            const current = (
              await tx<
                Account[]
              >`SELECT * FROM corestrum_private.accounts WHERE subject=${row.subject} FOR UPDATE`
            )[0]!;
            const device =
              await tx`SELECT device FROM corestrum_private.devices WHERE subject=${row.subject} AND device=${body.device} AND NOT revoked FOR UPDATE`;
            if (!device.length) throw new Error("DEVICE_REVOKED");
            return issue(current, body.device, tx);
          }),
        );
      }
      const { subject } = await identity(request, true);
      if (url.pathname === "/api/checkout" && isPlan(body.plan))
        return json(await billing.checkout(subject, body.plan));
      if (url.pathname === "/api/billing/portal")
        return json(await billing.portal(subject));
      if (url.pathname === "/api/license/activate") {
        if (
          Object.keys(body).some(
            (k) => !["publicKey", "device", "proof"].includes(k),
          )
        )
          throw new Error("INVALID_REQUEST");
        if (fingerprint(body.publicKey) !== body.device)
          throw new Error("INVALID_DEVICE_KEY");
        const nonce = await checkDeviceProof(
          body.proof,
          body.publicKey,
          body.device,
          config.origin + "/api/license/activate",
        );
        const a = await billing.account(subject);
        if (a.customer) await billing.reconcile(a.customer);
        const result = await billing.sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${subject},0))`;
          await tx`INSERT INTO corestrum_private.nonces(nonce,expires_at) VALUES(${nonce}::uuid,now()+interval '60 seconds')`;
          const current = (
            await tx<
              Account[]
            >`SELECT * FROM corestrum_private.accounts WHERE subject=${subject} FOR UPDATE`
          )[0]!;
          const devices =
            await tx`SELECT device,revoked FROM corestrum_private.devices WHERE subject=${subject} FOR UPDATE`;
          const own = devices.find((d) => d.device === body.device);
          if (own?.revoked) throw new Error("DEVICE_REVOKED");
          if (!own && devices.filter((d) => !d.revoked).length >= 2)
            throw new Error("DEVICE_LIMIT");
          await tx`INSERT INTO corestrum_private.devices(subject,device,public_key) VALUES(${subject},${body.device},${tx.json(body.publicKey)}::jsonb) ON CONFLICT DO NOTHING`;
          await billing.audit(subject, "device.activated", body.device, tx);
          return issue(current, body.device, tx);
        });
        return json(result);
      }
      if (url.pathname === "/api/license/revoke") {
        const changed =
          await billing.sql`UPDATE corestrum_private.devices SET revoked=true WHERE subject=${subject} AND device=${body.device} RETURNING device`;
        if (!changed.length) throw new Error("NOT_FOUND");
        await billing.audit(subject, "device.revoked", body.device);
        return json({ revoked: true });
      }
      return json({ error: "NOT_FOUND" }, 404);
    } catch (e) {
      if (e instanceof Error && e.message === "MFA_REQUIRED")
        return reverificationErrorResponse("strict_mfa");
      const known = new Set([
        "SIGN_IN_REQUIRED",
        "SESSION_REVOKED",
        "ORIGIN_REJECTED",
        "MFA_REQUIRED",
        "MFA_ENROLLMENT_REQUIRED",
        "BILLING_REVIEW_REQUIRED",
        "PAYMENT_REQUIRED",
        "ALREADY_LICENSED",
        "PAYMENT_RECONCILIATION_PENDING",
        "NO_BILLING_ACCOUNT",
        "DEVICE_REVOKED",
        "DEVICE_LIMIT",
        "INVALID_DEVICE_KEY",
        "INVALID_DEVICE_PROOF",
        "BODY_TOO_LARGE",
        "INVALID_REQUEST",
        "NOT_FOUND",
      ]);
      const code =
        e instanceof Error && known.has(e.message)
          ? e.message
          : "REQUEST_UNAVAILABLE";
      return json(
        { error: code },
        code === "NOT_FOUND"
          ? 404
          : code === "SIGN_IN_REQUIRED"
          ? 401
          : code === "REQUEST_UNAVAILABLE"
            ? 503
            : 403,
      );
    }
  };
}
