/** Environment boundary only; Stripe validates the credential itself. */
export function stripeKeyMatchesEnvironment(
  key: string,
  environment: "staging" | "production",
) {
  return environment === "production"
    ? /^(sk|rk)_live_/.test(key)
    : /^(?:(sk|rk)_test_|rkcs_test_)/.test(key);
}
