import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
// Envelope primitive. Production keys still require independent KMS lifecycle controls.
export function seal(
  key: Buffer,
  org: string,
  installation: string,
  value: string,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([org, installation, 1])));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}
export function unseal(
  key: Buffer,
  org: string,
  installation: string,
  envelope: string,
) {
  const bytes = Buffer.from(envelope, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(JSON.stringify([org, installation, 1])));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
