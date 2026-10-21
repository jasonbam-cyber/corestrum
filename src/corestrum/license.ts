import { SignJWT, importJWK, jwtVerify, type JWK } from "jose";
import { isPlan, type Plan } from "./catalog";

export type License = {
  id: string;
  workspace: string;
  device: string;
  issued: number;
  expires: number | null;
  environment: "staging" | "production";
} & ({ plan: Plan; major: number; updatesUntil: number; grantId?: never }
  | { plan: "complimentary"; major: null; updatesUntil: null; expires: null; grantId: string });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const issuer = "https://corestrum.com/licensing/v1";
export async function signLicense(
  license: License,
  privateKey: JWK,
  kid: string,
) {
  const token = new SignJWT({ ...license })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "corestrum-license+jwt" })
    .setIssuer(issuer)
    .setAudience("corestrum-local")
    .setSubject(license.id)
    .setIssuedAt(license.issued);
  if (license.expires !== null) token.setExpirationTime(license.expires);
  return token.sign(await importJWK(privateKey, "EdDSA"));
}
export async function verifyLicense(
  token: string,
  publicKey: JWK,
  expected: {
    device: string;
    environment: License["environment"];
    major: number;
  },
  now = Math.floor(Date.now() / 1000),
): Promise<License> {
  if (token.length > 8192 || publicKey.d) throw new Error("INVALID_LICENSE");
  const { payload: p, protectedHeader: h } = await jwtVerify(
    token,
    await importJWK(publicKey, "EdDSA"),
    {
      algorithms: ["EdDSA"],
      issuer,
      audience: "corestrum-local",
      typ: "corestrum-license+jwt",
      currentDate: new Date(now * 1000),
    },
  );
  if (
    !h.kid ||
    p.device !== expected.device ||
    p.environment !== expected.environment ||
    (p.plan !== "complimentary" && (p.major !== expected.major || !isPlan(p.plan))) ||
    typeof p.id !== "string" ||
    p.id !== p.sub ||
    typeof p.workspace !== "string" ||
    !uuid.test(p.workspace) ||
    !Number.isSafeInteger(p.issued) ||
    (p.issued as number) > now + 30 ||
    p.issued !== p.iat
  )
    throw new Error("INVALID_LICENSE");
  if (p.plan === "complimentary") {
    if (p.major !== null || p.updatesUntil !== null || p.expires !== null || p.exp !== undefined || typeof p.grantId !== "string" || !uuid.test(p.grantId))
      throw new Error("INVALID_LICENSE");
    return {
      id: p.id, workspace: p.workspace, device: p.device as string,
      plan: "complimentary", major: null, updatesUntil: null, expires: null,
      grantId: p.grantId, issued: p.issued as number,
      environment: p.environment as License["environment"],
    };
  }
  if (!isPlan(p.plan) || !Number.isSafeInteger(p.updatesUntil) || p.grantId !== undefined)
    throw new Error("INVALID_LICENSE");
  if (p.plan === "perpetual") {
    if (p.expires !== null || p.exp !== undefined)
      throw new Error("INVALID_LICENSE");
  } else if (
    !Number.isSafeInteger(p.expires) ||
    p.exp !== p.expires ||
    (p.expires as number) > (p.issued as number) + 7 * 86400 ||
    (p.expires as number) <= now
  )
    throw new Error("LICENSE_EXPIRED");
  return {
    id: p.id,
    workspace: p.workspace,
    device: p.device as string,
    plan: p.plan,
    major: p.major as number,
    issued: p.issued as number,
    expires: p.expires as number | null,
    updatesUntil: p.updatesUntil as number,
    environment: p.environment as License["environment"],
  };
}
