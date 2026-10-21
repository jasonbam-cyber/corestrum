import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";
import { validateDesktopRelease } from "../src/corestrum/local/release-config";

test("Mac release config accepts only an HTTPS origin and public Ed25519 verifier", async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  const key = await exportJWK(pair.publicKey);
  const config = { environment: "staging", cloudOrigin: "https://corestrum-staging.example", licensePublicKey: key };
  const validated = await validateDesktopRelease(config);
  if (validated.edition === "community") throw Error("unexpected edition");
  expect(validated.licensePublicKey.x).toBe(key.x);
  for (const change of [
    { licensePublicKey: await exportJWK(pair.privateKey) }, { signingKey: "forbidden" },
    { environment: "test" }, { cloudOrigin: "http://127.0.0.1:4393" },
    { cloudOrigin: "https://name:secret@corestrum-staging.example" },
    { cloudOrigin: "https://corestrum-staging.example/path" },
    { licensePublicKey: { ...key, key_ops: ["sign"] } },
  ]) await expect(validateDesktopRelease({ ...config, ...change })).rejects.toThrow();
});

test("community release contains no remote licensing configuration", async () => {
  expect(await validateDesktopRelease({ edition: "community" })).toEqual({ edition: "community" });
  for (const value of [{ edition: "community", cloudOrigin: "https://example.com" }, { edition: "free" }, {}])
    await expect(validateDesktopRelease(value)).rejects.toThrow();
});
