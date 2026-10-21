import * as oidc from "openid-client";
import { Denied, httpsOrigin } from "./common";
import type { Identity } from "./identity";

export type LoginTransaction = {
  state: string;
  nonce: string;
  verifier: string;
};
export interface IdentityProvider {
  begin(): Promise<{ url: string; transaction: LoginTransaction }>;
  complete(url: URL, transaction: LoginTransaction): Promise<Identity>;
  active(identity: Identity): Promise<boolean>;
}
export async function oidcProvider(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  origin: string;
  requiredAcr: string;
}): Promise<IdentityProvider> {
  const origin = httpsOrigin(options.origin),
    issuer = new URL(options.issuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    !options.requiredAcr ||
    !options.clientId ||
    !options.clientSecret
  )
    throw new Error("INVALID_OIDC_CONFIGURATION");
  const config = await oidc.discovery(
    issuer,
    options.clientId,
    options.clientSecret,
    undefined,
    { timeout: 5 },
  );
  return providerFromConfiguration(config, options);
}
// Configuration injection is used by the protocol test harness, not exposed via HTTP.
export function providerFromConfiguration(
  config: oidc.Configuration,
  options: { origin: string; requiredAcr: string; clientId: string },
): IdentityProvider {
  const origin = httpsOrigin(options.origin);
  // Validate ID-token signatures even when received directly over TLS.
  oidc.enableNonRepudiationChecks(config);
  const metadata = config.serverMetadata();
  for (const key of [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "introspection_endpoint",
  ] as const) {
    const endpoint = metadata[key];
    if (!endpoint || new URL(endpoint).protocol !== "https:")
      throw new Error("OIDC_HTTPS_AND_INTROSPECTION_REQUIRED");
  }
  const redirect_uri = origin + "/auth/callback";
  return {
    async begin() {
      const transaction = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
      };
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri,
        scope: "openid",
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: await oidc.calculatePKCECodeChallenge(
          transaction.verifier,
        ),
        state: transaction.state,
        nonce: transaction.nonce,
        acr_values: options.requiredAcr,
        max_age: "0",
      });
      return { url: url.href, transaction };
    },
    async complete(url, t) {
      const tokens = await oidc.authorizationCodeGrant(config, url, {
        expectedState: t.state,
        expectedNonce: t.nonce,
        pkceCodeVerifier: t.verifier,
        idTokenExpected: true,
        maxAge: 300,
      });
      const claims = tokens.claims();
      if (
        !claims ||
        claims.acr !== options.requiredAcr ||
        !claims.auth_time ||
        claims.auth_time * 1000 > Date.now() + 30_000 ||
        claims.auth_time * 1000 < Date.now() - 300_000 ||
        !tokens.expires_in
      )
        throw new Denied("MFA_REQUIRED", 401);
      return {
        issuer: claims.iss,
        subject: claims.sub,
        accessToken: tokens.access_token,
        expires: Date.now() + Math.min(tokens.expires_in, 3600) * 1000,
      };
    },
    async active(identity) {
      // Do not cache: disabled identities/revoked tokens fail closed at the next request.
      const token = await oidc.tokenIntrospection(config, identity.accessToken);
      return (
        token.active === true &&
        token.sub === identity.subject &&
        token.client_id === options.clientId &&
        typeof token.exp === "number" &&
        token.exp * 1000 > Date.now() &&
        identity.issuer === metadata.issuer
      );
    },
  };
}
