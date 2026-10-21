import { importJWK, type JWK } from "jose";

export type LicensedRelease = {
  edition?: undefined;
  environment: "staging" | "production";
  cloudOrigin: string;
  licensePublicKey: JWK;
};

export type DesktopRelease = LicensedRelease | { edition: "community" };

/** Downloads contain only a public verification key, never signing/provider credentials. */
export async function validateDesktopRelease(value: unknown): Promise<DesktopRelease> {
  if (value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).join() === "edition" && (value as { edition: unknown }).edition === "community")
    return { edition: "community" };
  const v = value as LicensedRelease;
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).sort().join(",") !== "cloudOrigin,environment,licensePublicKey" ||
      !["staging", "production"].includes(v.environment) || typeof v.cloudOrigin !== "string")
    throw Error("INVALID_RELEASE_CONFIGURATION");
  const origin = new URL(v.cloudOrigin);
  if (origin.protocol !== "https:" || origin.origin !== v.cloudOrigin || origin.username || origin.password)
    throw Error("INVALID_RELEASE_CONFIGURATION");
  const key = v.licensePublicKey;
  if (!key || typeof key !== "object" || Array.isArray(key) ||
      Object.keys(key).some((k) => !["kty", "crv", "x", "kid", "alg", "use", "key_ops", "ext"].includes(k)) ||
      key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key.x) || (key.alg && key.alg !== "EdDSA") ||
      (key.use && key.use !== "sig") || (key.key_ops && (key.key_ops.length !== 1 || key.key_ops[0] !== "verify")))
    throw Error("INVALID_RELEASE_CONFIGURATION");
  await importJWK(key, "EdDSA");
  return v;
}
