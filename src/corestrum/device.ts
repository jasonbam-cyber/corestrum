import { createHash } from "node:crypto";
import { importJWK, jwtVerify, type JWK } from "jose";
export function fingerprint(jwk: JWK) {
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
    jwk.d ||
    Object.keys(jwk).some((k) => !["kty", "crv", "x"].includes(k))
  )
    throw new Error("INVALID_DEVICE_KEY");
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("hex");
}
export async function checkDeviceProof(
  proof: string,
  key: JWK,
  device: string,
  audience: string,
  now = Date.now(),
) {
  const { payload } = await jwtVerify(proof, await importJWK(key, "EdDSA"), {
    algorithms: ["EdDSA"],
    audience,
    subject: device,
    typ: "corestrum-device+jwt",
    currentDate: new Date(now),
  });
  if (
    fingerprint(key) !== device ||
    !payload.jti ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      payload.jti,
    ) ||
    !payload.iat ||
    !payload.exp ||
    payload.exp - payload.iat > 60 ||
    payload.iat > now / 1000 + 5
  )
    throw new Error("INVALID_DEVICE_PROOF");
  return payload.jti;
}
