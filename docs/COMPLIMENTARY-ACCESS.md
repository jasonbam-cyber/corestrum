# Optional legacy complimentary licensing reference

The public community app is free without this system. This document describes the retained optional hosted licensing implementation, which requires dedicated operator infrastructure.

This is an operator-granted entitlement, separate from the three legacy paid plans. It waives Corestrum purchase and renewal fees and includes future major versions. AI and other external services remain customer-funded. No price, successful payment, customer subscription or email allowlist is fabricated.

## Account binding and operator procedure

The customer first signs in through Corestrum's normal identity provider. The operator verifies the authenticated subject and the workspace created for that subject against the private approved pilot record. Never use an email address as license authority or commit a recipient list. A forwarded email or an unverified address is not proof of account ownership.

After the release owner approves and applies both ordered licensing migrations, a separately authorized database administrator may provision an individually attributable operator login with the `corestrum_grants` role. The migration leaves this role `NOLOGIN`; it does not create credentials. Operator credentials must never be available to the web application, packaged local app, logs, repository, or a browser. The web role cannot grant or revoke complimentary access.

The operator-only module `src/corestrum/cloud/complimentary.ts` exposes `grantComplimentary(sql, request)`. Its strict request requires the verified `subject`, `workspace`, exact `environment`, an `approvalReference`, and a human-readable `reason`. Use a protected operator connection, with credentials loaded from a protected file or approved secret store, not shell arguments or a command transcript. There is deliberately no customer-facing grant endpoint or automatic email matching.

The database rejects missing or mismatched accounts, billing holds, any existing payment customer, checkout, subscription, payment intent, or paid account. Resolve existing billing separately before considering a new grant; this feature must not leave an unnoticed paid subscription running. Checkout and granting take the same account lock, including direct operator inserts. An exact retry returns the original grant; a conflicting or revoked grant cannot be silently replaced.

The grant and any later revocation are append-only records. Database defaults capture `session_user` and the timestamp; the operator cannot supply those fields or update/delete history. Keep the approval reference resolvable in the private approval record. This controls the ordinary operator and web roles; a database superuser remains an administrator requiring separate governance.

## Customer experience and limits

The account page shows lifetime complimentary access, omits paid checkout and subscription management, and retains the normal recent-MFA and device proof requirements. Each license is signed and bound to the account's workspace, device key and environment. The two-computer allowance still applies. Reinstallation or replacement requires normal authenticated activation; the entitlement is stored against the account rather than a particular download.

Complimentary licenses have no expiry, renewal date or major-version restriction. Paid perpetual licenses keep their existing major-version boundary. The public catalog never accepts `complimentary` as a purchasable plan. No AI credential or usage subsidy is included.

An independently authorized `revokeComplimentary` operation appends a reasoned revocation and prevents future issuance/refresh. It cannot erase a previously issued offline perpetual license. Device revocation has the same offline limitation. Do not promise immediate remote disabling. Reinstating a revoked grant is not supported by this initial operator path.

## Qualification and release requirements

`bun test tests/complimentary-license.test.ts` checks signed lifetime semantics, future versions, tampering and wrong-device/environment rejection. `bun run test:licensing` uses a disposable PostgreSQL database with restricted roles, injected identity/MFA outcomes and Stripe fixtures. It tests immutable operator history, role escalation denial, account isolation, competing checkout/grant operations, device limits, refresh and revocation without provider payments. These are local/component checks, not hosted signup/MFA or customer proof.

The licensing test also covers a repaired device-public-key serialization defect: activation must persist a JSON object via Postgres.js `tx.json`, not a double-encoded JSON string, for later signed refresh to work. Existing installations with string-encoded device keys require a separately reviewed repair or re-enrollment; this change does not silently rewrite old keys.

Before any live pilot, the release owner must approve the new source candidate and migration, verify protected configuration, and qualify the actual hosted complimentary account/device path separately from paid checkout. No recipient has been granted access by adding this source. Signing, installer, customer-owned AI authentication, backup/restore and the first useful report remain independent readiness gates. Software checks alone do not constitute SOC 2 attestation.
