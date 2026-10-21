import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
export const BACKUP_MAX_BYTES = 6 * 1024 * 1024;
const PLAIN_MAX_BYTES = 4 * 1024 * 1024;
function passwordCheck(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < 16 || password.length > 256) throw Error("BACKUP_PASSPHRASE_LENGTH");
}
async function keyFor(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
const aad = Buffer.from("corestrum-business-backup:v1");
export async function encryptBackup(value: unknown, password: unknown) {
  passwordCheck(password);
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > PLAIN_MAX_BYTES) throw Error("BACKUP_TOO_LARGE");
  const salt = randomBytes(16), iv = randomBytes(12), key = await keyFor(password, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { format: "corestrum-business-backup", version: 1, kdf: "scrypt-32768-8-1", salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("base64") };
  } finally { key.fill(0); plain.fill(0); }
}
export async function decryptBackup(raw: unknown, password: unknown): Promise<unknown> {
  passwordCheck(password);
  if (typeof raw !== "string" || Buffer.byteLength(raw) > BACKUP_MAX_BYTES) throw Error("INVALID_BACKUP");
  let box: any;
  try { box = JSON.parse(raw); } catch { throw Error("INVALID_BACKUP"); }
  if (!box || typeof box !== "object" || Array.isArray(box) || Object.keys(box).sort().join() !== ["format", "version", "kdf", "salt", "iv", "tag", "ciphertext"].sort().join() || box.format !== "corestrum-business-backup" || box.version !== 1 || box.kdf !== "scrypt-32768-8-1" || typeof box.salt !== "string" || !/^[a-f0-9]{32}$/.test(box.salt) || typeof box.iv !== "string" || !/^[a-f0-9]{24}$/.test(box.iv) || typeof box.tag !== "string" || !/^[a-f0-9]{32}$/.test(box.tag) || typeof box.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(box.ciphertext)) throw Error("INVALID_BACKUP");
  const encrypted = Buffer.from(box.ciphertext, "base64");
  if (encrypted.length > PLAIN_MAX_BYTES || encrypted.toString("base64") !== box.ciphertext) throw Error("INVALID_BACKUP");
  const key = await keyFor(password, Buffer.from(box.salt, "hex"));
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "hex"));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(box.tag, "hex"));
    plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch { throw Error("BACKUP_UNLOCK_FAILED"); }
  finally { key.fill(0); plain?.fill(0); }
}
