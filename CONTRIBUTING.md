# Contributing

Open an issue for bugs or a focused pull request with the user-visible problem, behavior change and relevant validation. Use fictional businesses and data. Report security problems through the private process in SECURITY.md.

Install the locked dependencies with `bun install --frozen-lockfile --ignore-scripts`, then run `bun run check` and `bun run guard:public`. Explain affected trust boundaries and add meaningful negative tests for security changes. Do not weaken authentication, use real provider accounts in CI, add paid fallback, or auto-enable routines.

Contributions are submitted under Apache License 2.0. Preserve dependency copyrights and licenses. Submit only work you have the right to contribute; exclude employer/customer information and credentials.
