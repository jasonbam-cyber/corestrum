import { expect, test } from "bun:test";
import { stripeKeyMatchesEnvironment } from "../src/corestrum/cloud/key-environment";

test("temporary Stripe sandbox credentials stay confined to staging", () => {
  for (const key of ["sk_test_synthetic", "rk_test_synthetic", "rkcs_test_synthetic"]) {
    expect(stripeKeyMatchesEnvironment(key, "staging")).toBe(true);
    expect(stripeKeyMatchesEnvironment(key, "production")).toBe(false);
  }
  for (const key of ["sk_live_synthetic", "rk_live_synthetic"]) {
    expect(stripeKeyMatchesEnvironment(key, "production")).toBe(true);
    expect(stripeKeyMatchesEnvironment(key, "staging")).toBe(false);
  }
  for (const key of ["", "rkcs_live_synthetic", "pk_test_synthetic", "unknown"]) {
    expect(stripeKeyMatchesEnvironment(key, "staging")).toBe(false);
    expect(stripeKeyMatchesEnvironment(key, "production")).toBe(false);
  }
});
