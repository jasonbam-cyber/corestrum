import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import { signLicense, verifyLicense, type License } from "../src/corestrum/license";
import { isPlan } from "../src/corestrum/catalog";
import { validateGrantRequest } from "../src/corestrum/cloud/complimentary";

const pair = await generateKeyPair("EdDSA", { extractable: true });
const privateKey = await exportJWK(pair.privateKey);
const publicKey = await exportJWK(pair.publicKey);
const now = Math.floor(Date.now() / 1000);
const workspace = randomUUID();
const grant: License = {
  id: workspace, workspace, device: "fixture-device", plan: "complimentary",
  major: null, issued: now, expires: null, updatesUntil: null,
  environment: "staging", grantId: randomUUID(),
};
const expected = { device: grant.device, environment: "staging" as const, major: 1 };

describe("complimentary licenses", () => {
  test("lifetime grant survives future versions and years without a renewal", async () => {
    const token = await signLicense(grant, privateKey, "test-grant");
    const later = await verifyLicense(token, publicKey, { ...expected, major: 12 }, now + 20 * 365 * 86400);
    expect(later.plan).toBe("complimentary");
    expect(later.expires).toBeNull();
    expect(later.updatesUntil).toBeNull();
    expect(later.workspace).toBe(workspace);
    expect(later.grantId).toBe(grant.grantId);
  });
  test("free access retains device, environment and signature checks", async () => {
    const token = await signLicense(grant, privateKey, "test-grant");
    await expect(verifyLicense(token, publicKey, { ...expected, device: "foreign" })).rejects.toThrow();
    await expect(verifyLicense(token, publicKey, { ...expected, environment: "production" })).rejects.toThrow();
    const other = await generateKeyPair("EdDSA", { extractable: true });
    await expect(verifyLicense(token, await exportJWK(other.publicKey), expected)).rejects.toThrow();
    const pieces = token.split(".");
    const payload = JSON.parse(Buffer.from(pieces[1]!, "base64url").toString());
    payload.workspace = randomUUID();
    pieces[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    await expect(verifyLicense(pieces.join("."), publicKey, expected)).rejects.toThrow();
  });
  test("malformed or hybrid grants fail closed", async () => {
    for (const change of [
      { major: 1 }, { updatesUntil: now }, { expires: now + 60 },
      { grantId: "not-a-grant" }, { grantId: undefined },
      { plan: "perpetual", major: 1, updatesUntil: now + 86400 },
    ]) {
      const token = await signLicense({ ...grant, ...change } as License, privateKey, "test-grant");
      await expect(verifyLicense(token, publicKey, expected)).rejects.toThrow();
    }
  });
  test("paid version-one licenses do not acquire lifetime upgrades", async () => {
    const paid: License = { ...grant, plan: "perpetual", major: 1, updatesUntil: now + 86400, grantId: undefined };
    const token = await signLicense(paid, privateKey, "test-paid");
    expect((await verifyLicense(token, publicKey, expected)).plan).toBe("perpetual");
    await expect(verifyLicense(token, publicKey, { ...expected, major: 2 })).rejects.toThrow();
    expect(isPlan("complimentary")).toBe(false);
  });
  test("grant request requires account/workspace binding, not an email allowlist", () => {
    const request = { subject: "user_fixture", workspace, environment: "staging", approvalReference: "fixture-approval", reason: "Synthetic pilot" };
    expect(() => validateGrantRequest(request)).not.toThrow();
    for (const change of [{ subject: "person@example.test" }, { workspace: "" }, { approvalReference: "" }, { environment: "development" }, { grantId: randomUUID() }])
      expect(() => validateGrantRequest({ ...request, ...change })).toThrow("INVALID_GRANT_REQUEST");
  });
});
