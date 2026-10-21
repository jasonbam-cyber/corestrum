import { createClerkClient } from "@clerk/backend";
export function clerkIdentity(config: {
  secretKey: string;
  publishableKey: string;
  origin: string;
}) {
  const client = createClerkClient({
    secretKey: config.secretKey,
    publishableKey: config.publishableKey,
  });
  return async (request: Request, sensitive = false) => {
    if (new URL(request.url).origin !== config.origin)
      throw new Error("ORIGIN_REJECTED");
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !== config.origin
    )
      throw new Error("ORIGIN_REJECTED");
    const state = await client.authenticateRequest(request, {
      authorizedParties: [config.origin],
      acceptsToken: "session_token",
    });
    const auth = state.toAuth();
    if (!auth?.userId || !auth.sessionId) throw new Error("SIGN_IN_REQUIRED");
    const session = await client.sessions.getSession(auth.sessionId);
    if (
      session.status !== "active" ||
      session.userId !== auth.userId ||
      session.expireAt <= Date.now()
    )
      throw new Error("SESSION_REVOKED");
    if (
      sensitive &&
      !(await client.users.getUser(auth.userId)).twoFactorEnabled
    )
      throw new Error("MFA_ENROLLMENT_REQUIRED");
    if (
      sensitive &&
      (!hasFreshSecondFactor(auth.sessionClaims.fva) ||
        !auth.has({ reverification: "strict_mfa" }))
    )
      throw new Error("MFA_REQUIRED");
    return { subject: auth.userId, session: auth.sessionId };
  };
}

export function hasFreshSecondFactor(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => Number.isFinite(v) && v >= 0 && v < 10)
  );
}
