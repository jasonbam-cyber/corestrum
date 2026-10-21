import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";

type Box = { v: 1; salt: string; iv: string; tag: string; ciphertext: string };
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export class LocalVault {
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  private values: Record<string, string> = {};
  private lastTouch = 0;
  constructor(
    readonly path: string,
    private readonly now = Date.now,
  ) {}
  get exists() {
    return existsSync(this.path);
  }
  get unlocked() {
    if (this.key && this.now() - this.lastTouch > 15 * 60 * 1000) this.lock();
    return this.key !== null;
  }
  // Internal reads and scheduled work validate access without extending human inactivity.
  touch() {
    if (!this.unlocked) throw new Error("VAULT_LOCKED");
  }
  activity() {
    this.touch();
    this.lastTouch = this.now();
  }
  async unlock(password: string) {
    if (
      typeof password !== "string" ||
      password.length < 14 ||
      password.length > 256
    )
      throw new Error("PASSPHRASE_LENGTH");
    this.lock();
    let box: Box | undefined;
    if (this.exists) {
      const info = lstatSync(this.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 1024 * 1024
      )
        throw new Error("UNSAFE_VAULT_FILE");
      box = JSON.parse(readFileSync(this.path, "utf8"));
      if (
        !box ||
        box.v !== 1 ||
        !/^[a-f0-9]{32}$/.test(box.salt) ||
        !/^[a-f0-9]{24}$/.test(box.iv) ||
        !/^[a-f0-9]{32}$/.test(box.tag)
      )
        throw new Error("INVALID_VAULT");
    }
    const salt = box ? Buffer.from(box.salt, "hex") : randomBytes(16),
      key = await derive(password, salt);
    try {
      if (box) {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(box.iv, "hex"),
        );
        decipher.setAAD(Buffer.from("corestrum-local-vault:v1"));
        decipher.setAuthTag(Buffer.from(box.tag, "hex"));
        this.values = JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(box.ciphertext, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        );
      }
      this.key = key;
      this.salt = salt;
      this.lastTouch = this.now();
      if (!box) this.save();
    } catch {
      key.fill(0);
      this.lock();
      throw new Error("VAULT_UNLOCK_FAILED");
    }
  }
  lock() {
    this.key?.fill(0);
    this.key = null;
    this.salt = null;
    this.values = {};
  }
  has(name: string) {
    this.touch();
    return Object.hasOwn(this.values, name);
  }
  get(name: string) {
    this.touch();
    return this.values[name];
  }
  set(name: string, value: string) {
    this.touch();
    if (value.length > 200000) throw new Error("VALUE_TOO_LARGE");
    this.values[name] = value;
    this.save();
  }
  remove(name: string) {
    this.touch();
    delete this.values[name];
    this.save();
  }
  seal(text: string, aad: string) {
    this.touch();
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key!, iv);
    c.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return JSON.stringify({
      iv: iv.toString("hex"),
      tag: c.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("base64"),
    });
  }
  unseal(value: string, aad: string) {
    this.touch();
    const b = JSON.parse(value),
      d = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(b.iv, "hex"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(b.tag, "hex"));
    return Buffer.concat([
      d.update(Buffer.from(b.ciphertext, "base64")),
      d.final(),
    ]).toString("utf8");
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const b = JSON.parse(
      this.seal(JSON.stringify(this.values), "corestrum-local-vault:v1"),
    );
    const temp = this.path + "." + randomBytes(8).toString("hex") + ".tmp";
    writeFileSync(
      temp,
      JSON.stringify({ v: 1, salt: this.salt!.toString("hex"), ...b }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
  }
}
