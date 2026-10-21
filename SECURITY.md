# Security policy

Corestrum is a source preview. No claim of vulnerability-free software, independent penetration-test assurance, live deployment qualification or SOC 2 attestation is made.

## Report a vulnerability privately

Use **Security → Advisories → Report a vulnerability** on this GitHub repository. Include the affected commit, reproducible steps with fictional data, expected boundary and impact. Do not put credentials, personal information, customer data or exploit details in public issues. If private reporting is temporarily unavailable, open an issue asking for a private reporting route without sensitive details.

Only the current main branch is maintained during preview. No response-time or security-update SLA is promised. Confirmed credential exposures require revocation/rotation as well as source cleanup.

## Execution boundaries

- **Community local app:** trusted local OS account, loopback listener, single-use bootstrap, session/origin/CSRF checks and encrypted passphrase vault. Free access does not bypass these controls. The community identity is a random local workspace identifier, not a remote login or a signed commercial entitlement.
- **Optional hosted foundation:** dedicated OIDC identity, explicit membership, MFA-context verification, per-customer workers and restricted bridge. Server and infrastructure setup must be independently qualified. A copied repository supplies no access to a maintainer service or another application.
- **Legacy licensing reference:** optional Clerk/Stripe/device licensing, separate from the free local path; never reuse another business's credentials or cloud resources.
- **Synthetic demo:** fictional data and intentionally selectable local demo identities. It must stay on loopback and must never hold real credentials or customer data.

AI roles generate text for review. They have no generic shell, database-write or deployment tool. The optional Claude subprocess relies on its official binary and documented restrictions; private profiles are not an OS sandbox. Chosen providers receive the prompts and business context you send to them.

Vault encryption does not encrypt every SQLite metadata field or protect an unlocked process from the OS administrator. Local audit chains are not immutable against that administrator. Backup limits and recovery behavior are documented separately.

## Contributor and release rules

Never commit secrets, `.env` values, databases, private keys, OAuth tokens, private launch links, customer exports, screenshots of private data or internal deployment records. Use only fictional fixtures. Do not add a maintainer's host, account, project, credentials or runner to default setup.

Pull requests run on disposable GitHub-hosted runners with read-only permissions and no deployment secrets. Do not introduce `pull_request_target` execution of contributor code or self-hosted runners for public contributions. Pin workflow actions to reviewed commits.

Changes to authentication, storage, backup restore, connectors, subprocesses or network destinations require negative-boundary tests and review. Tenant escape, unauthorized action, credential exposure and approval bypass are release blockers. Public ingress, multi-user hosting, signing/notarization and compiled-runtime redistribution are separate qualification work; a source build is not proof of any of them.
