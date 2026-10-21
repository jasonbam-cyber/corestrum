import { expect, test } from "bun:test";
import * as oidc from "openid-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { providerFromConfiguration } from "../src/production/oidc";

async function setup() {
  const issuer = "https://identity.example.test",
    clientId = "waypoint",
    origin = "https://portal.example.test",
    acr = "urn:test:mfa";
  const keys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "one",
    use: "sig",
    alg: "RS256",
  };
  const config = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token",
      jwks_uri: issuer + "/jwks",
      introspection_endpoint: issuer + "/introspect",
      id_token_signing_alg_values_supported: ["RS256"],
    },
    clientId,
    "server-secret",
  );
  let authorization: URL,
    override: Record<string, unknown> = {},
    active = true,
    badSignature = false,
    seenVerifier = false;
  config[oidc.customFetch] = async (input, init) => {
    const url = String(input),
      body = new URLSearchParams(String(init?.body));
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/token")) {
      if (
        (await oidc.calculatePKCECodeChallenge(
          body.get("code_verifier") ?? "",
        )) !== authorization.searchParams.get("code_challenge")
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      seenVerifier = true;
      const signing = badSignature
        ? (await generateKeyPair("RS256")).privateKey
        : keys.privateKey;
      const id_token = await new SignJWT({
        nonce: authorization.searchParams.get("nonce"),
        acr,
        auth_time: Math.floor(Date.now() / 1000),
        ...override,
      })
        .setProtectedHeader({ alg: "RS256", kid: "one" })
        .setIssuer(String(override.iss ?? issuer))
        .setSubject("subject-123")
        .setAudience(String(override.aud ?? clientId))
        .setIssuedAt()
        .setExpirationTime(String(override.ttl ?? "5m"))
        .sign(signing);
      return Response.json({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token,
      });
    }
    if (url.endsWith("/introspect"))
      return Response.json({
        active,
        sub: "subject-123",
        client_id: clientId,
        exp: Math.floor(Date.now() / 1000) + 300,
      });
    throw new Error("unexpected endpoint");
  };
  const provider = providerFromConfiguration(config, {
    origin,
    clientId,
    requiredAcr: acr,
  });
  const begin = await provider.begin();
  authorization = new URL(begin.url);
  const callback = () =>
    new URL(
      origin +
        "/auth/callback?code=one&state=" +
        authorization.searchParams.get("state"),
    );
  return {
    provider,
    begin,
    authorization,
    callback,
    override: (v: Record<string, unknown>) => {
      override = v;
    },
    badSignature: () => {
      badSignature = true;
    },
    revoke: () => {
      active = false;
    },
    seenVerifier: () => seenVerifier,
  };
}
test("actual OIDC library verifies signed ID token, PKCE, state, nonce, MFA and introspection", async () => {
  const f = await setup();
  expect(f.authorization.searchParams.get("code_challenge_method")).toBe(
    "S256",
  );
  const identity = await f.provider.complete(f.callback(), f.begin.transaction);
  expect(identity.subject).toBe("subject-123");
  expect(f.seenVerifier()).toBe(true);
  expect(await f.provider.active(identity)).toBe(true);
  f.revoke();
  expect(await f.provider.active(identity)).toBe(false);
});
test("OIDC rejects state mismatch, incorrect verifier, forged signature, nonce and missing MFA", async () => {
  const state = await setup(),
    url = state.callback();
  url.searchParams.set("state", "forged");
  await expect(
    state.provider.complete(url, state.begin.transaction),
  ).rejects.toThrow();
  const pkce = await setup();
  await expect(
    pkce.provider.complete(pkce.callback(), {
      ...pkce.begin.transaction,
      verifier: "wrong",
    }),
  ).rejects.toThrow();
  const sig = await setup();
  sig.badSignature();
  await expect(
    sig.provider.complete(sig.callback(), sig.begin.transaction),
  ).rejects.toThrow();
  for (const override of [
    { iss: "https://attacker.example.test" },
    { aud: "another-app" },
    { ttl: "-1m" },
    { nonce: "other" },
    { acr: "password-only" },
    { auth_time: 1 },
  ]) {
    const f = await setup();
    f.override(override);
    await expect(
      f.provider.complete(f.callback(), f.begin.transaction),
    ).rejects.toThrow();
  }
});
