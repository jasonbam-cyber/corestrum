import postgres from "postgres";
import Stripe from "stripe";
import { clerkIdentity } from "../src/corestrum/cloud/auth";
import { Billing } from "../src/corestrum/cloud/billing";
import { cloudHandler } from "../src/corestrum/cloud/handler";
import { PRODUCT } from "../src/corestrum/catalog";
import { stripeKeyMatchesEnvironment } from "../src/corestrum/cloud/key-environment";
let handler: ((request: Request) => Promise<Response>) | undefined;
function identityConfig() {
  const origin =
    process.env.CORESTRUM_ORIGIN ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL
      : undefined);
  if (
    !origin ||
    !process.env.CORESTRUM_CLERK_SECRET ||
    !process.env.CORESTRUM_CLERK_PUBLIC
  )
    return null;
  return {
    origin,
    secretKey: process.env.CORESTRUM_CLERK_SECRET,
    publishableKey: process.env.CORESTRUM_CLERK_PUBLIC,
  };
}
function configured() {
  return [
    "CORESTRUM_ORIGIN",
    "CORESTRUM_DATABASE_URL",
    "CORESTRUM_CLERK_SECRET",
    "CORESTRUM_CLERK_PUBLIC",
    "CORESTRUM_STRIPE_KEY",
    "CORESTRUM_STRIPE_WEBHOOK",
    "CORESTRUM_LICENSE_PRIVATE_JWK",
    "CORESTRUM_PRICE_MONTHLY",
    "CORESTRUM_PRICE_ANNUAL",
    "CORESTRUM_PRICE_PERPETUAL",
  ].every((k) => !!process.env[k]);
}
async function handle(request: Request) {
  if (
    new URL(request.url).pathname === "/api/identity" &&
    request.method === "GET"
  ) {
    const config = identityConfig();
    if (!config)
      return Response.json(
        { error: "AUTH_CONFIGURATION_PENDING" },
        { status: 503 },
      );
    try {
      await clerkIdentity(config)(request);
      return Response.json(
        { verified: true },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json(
        { error: "SIGN_IN_REQUIRED" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
  }
  if (!configured())
    return Response.json(
      new URL(request.url).pathname === "/api/config"
        ? {
            mode: "cloud",
            product: PRODUCT,
            environment: "staging",
            publishableKey: process.env.CORESTRUM_CLERK_PUBLIC ?? null,
            checkoutReady: false,
            downloadUrl: null,
          }
        : { error: "STAGING_CONFIGURATION_PENDING" },
      {
        status: new URL(request.url).pathname === "/api/config" ? 200 : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  if (!handler) {
    const e = process.env,
      environment =
        e.CORESTRUM_ENVIRONMENT === "production" ? "production" : "staging",
      origin = e.CORESTRUM_ORIGIN!;
    if (
      new URL(origin).protocol !== "https:" ||
      new URL(origin).origin !== origin
    )
      throw new Error("INVALID_ORIGIN");
    if (!stripeKeyMatchesEnvironment(e.CORESTRUM_STRIPE_KEY!, environment))
      throw new Error(
        environment === "staging"
          ? "STAGING_REQUIRES_STRIPE_SANDBOX"
          : "PRODUCTION_REQUIRES_LIVE_STRIPE",
      );
    const dbUrl = new URL(e.CORESTRUM_DATABASE_URL!);
    if (
      (!/\.supabase\.(com|co)$/.test(dbUrl.hostname) && dbUrl.hostname !== e.CORESTRUM_DATABASE_HOST) ||
      !dbUrl.username.startsWith("corestrum_licensing")
    )
      throw new Error("DEDICATED_DATABASE_ROLE_REQUIRED");
    const sql = postgres(e.CORESTRUM_DATABASE_URL!, {
      prepare: false,
      max: 2,
      ssl: { rejectUnauthorized: true },
      connect_timeout: 8,
      idle_timeout: 20,
      connection: {
        statement_timeout: 15000,
        application_name: "corestrum-licensing",
      },
    });
    const stripe = new Stripe(e.CORESTRUM_STRIPE_KEY!, {
      apiVersion: "2026-09-30.endive",
      maxNetworkRetries: 1,
      timeout: 15000,
    });
    const billing = new Billing(sql, stripe, {
      origin,
      environment,
      webhookSecret: e.CORESTRUM_STRIPE_WEBHOOK!,
      prices: {
        monthly: e.CORESTRUM_PRICE_MONTHLY!,
        annual: e.CORESTRUM_PRICE_ANNUAL!,
        perpetual: e.CORESTRUM_PRICE_PERPETUAL!,
      },
    });
    handler = cloudHandler(
      {
        origin,
        environment,
        publishableKey: e.CORESTRUM_CLERK_PUBLIC!,
        signingKey: JSON.parse(e.CORESTRUM_LICENSE_PRIVATE_JWK!),
        keyId: e.CORESTRUM_LICENSE_KEY_ID ?? "corestrum-staging-v1",
        downloadUrl: e.CORESTRUM_DOWNLOAD_URL,
      },
      billing,
      clerkIdentity({
        origin,
        secretKey: e.CORESTRUM_CLERK_SECRET!,
        publishableKey: e.CORESTRUM_CLERK_PUBLIC!,
      }),
    );
  }
  return handler(request);
}
export async function GET(request: Request) {
  try {
    return await handle(request);
  } catch {
    return Response.json(
      { error: "SERVICE_UNAVAILABLE" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
export async function POST(request: Request) {
  return GET(request);
}
