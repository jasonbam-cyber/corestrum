# Production authentication and customer boundaries

This is an implemented, tested deployment path, not an activated customer service. `bun run start` starts the free local community workspace. `bun run demo:synthetic` starts the separate fictional workflow demo. Production uses `src/production/server.ts`, a separate identity database and separate customer runtimes. The production image contains only bundled production entry points. It cannot create a demo session or execute the synthetic planner.

## Identity contract

Use a confidential OIDC application with authorization code flow, S256 PKCE, exact registered HTTPS redirect URI `<origin>/auth/callback`, ID-token signatures and a provider-enforced MFA authentication context (`requiredAcr`). The provider must support authenticated token introspection returning `active`, `sub`, `client_id`, and `exp`. An OIDC label alone does not establish this compatibility. Qualify the chosen provider against these fields before registering customers; there is no weaker fallback for a provider without introspection.

The server verifies state, nonce, signature, issuer, audience, recent `auth_time` and the configured MFA context. A requested `acr_values` is not proof of MFA; the returned signed claim must match the provider policy. Provider registration, its MFA policy, disabled-user behavior, logout and recovery must be tested in a dedicated identity environment before launch. No live identity provider was configured during this milestone.

Sessions use random 256-bit opaque cookies with `__Host-`, Secure, HttpOnly and SameSite=Lax. Tokens stay server-side, encrypted with AES-256-GCM and bound to a session identifier; only a hash of the cookie token is stored. Login transactions are encrypted, browser-bound, expire after five minutes and are consumed once. Sessions expire after at most one hour, have a 15-minute idle limit, and do not silently refresh. Logout deletes the server record. Every authenticated request performs fresh provider introspection and local membership lookup. Provider outages deny access. Membership is rechecked after asynchronous reads before returning their results.

Membership is an explicit `(issuer, immutable subject, customer UUID)` grant. Email addresses, email domains, browser fields, model output and user-editable identity metadata never assign a role. An operator uses `bun run enroll CONFIG_FILE ENROLLMENT_FILE` to grant/demote/revoke a membership; the operation is audited and invalidates selected sessions. There is no customer-facing membership administration endpoint or support impersonation. Multiple memberships allow selection only among assigned workspaces. Owners manage connections; viewers see status. An agent has no sign-in or owner role.

Example enrollment (identifiers are fictional):

```json
{
  "issuer": "https://identity.example.test/realms/waypoint",
  "subject": "immutable-provider-subject",
  "org": "11111111-1111-4111-8111-111111111111",
  "name": "Customer One",
  "role": "owner",
  "active": true,
  "operator": "change-request-identifier-and-operator"
}
```

Keep the operator CLI outside customer runtimes. It requires trusted control-plane storage access; it is not a model tool. Record the operator/change request and retain independent change review. Disable a customer by revoking its memberships and connection, then disabling its upstream identity access and following retention/offboarding policy. The platform does not infer authority from a paid subscription.

## Container isolation

`deploy/isolation.ts` renders a two-customer Docker Compose deployment from an image digest, two distinct customer UUIDs, two distinct project references, separate numeric user IDs and separate secret directories. Each runtime has its own data volume, socket volume, UID/GID, encryption key and gateway token. It has no host port, host PID namespace, Docker socket, shared business directory, or another customer's mount. Root filesystems are read-only; capabilities are dropped; privilege escalation is disabled; memory, CPU and PID limits are explicit. Docker's default seccomp profile must remain enabled.

Each worker is on one internal network without a direct internet route. Its own egress proxy forwards only POST JSON to the fixed Supabase project and function path, verifies upstream TLS, rejects redirects, and bounds response size and time. The browser cannot choose a URL. The gateway reaches workers through individually mounted Unix sockets and per-customer bearer credentials; the workers do not share the gateway's socket mounts or keys. Shared host/kernel or control-plane compromise is outside this boundary: use separate hosts/cloud identities where the customer risk profile requires it. The egress proxy itself has outbound networking; enforce the matching destination policy at the cloud firewall before live use.

Volume identity is checked before customer schema creation. Copying a database under another customer's configuration fails closed. Signing keys are envelope encrypted with customer and installation as authenticated context. Disconnect deletes the live signing-key reference and fences pending results. SQLite/WAL backups can retain old encrypted bytes; key destruction and retention remain an operational requirement, not a secure-erasure claim.

## Dedicated deployment configuration

Use dedicated hosts, identities, databases, credentials, ports and cloud projects for each deployment. Do not reuse another application’s secrets or `.env` files. Production starts with `bun --no-env-file server.js` and `PRODUCTION_CONFIG_FILE` naming a mounted configuration file. TLS is terminated by this gateway; do not disable TLS verification or trust arbitrary forwarded headers. Use the final product domain and a matching certificate. Port 8443 is bound to loopback by the Compose template; public ingress is deliberately a separate reviewed deployment step.

Gateway configuration:

```json
{
  "origin": "https://product.example.test",
  "port": 8443,
  "database": "/data/identity.sqlite",
  "sessionKeyFile": "/run/secrets/session-key",
  "tlsCertFile": "/run/secrets/tls-cert.pem",
  "tlsKeyFile": "/run/secrets/tls-key.pem",
  "issuer": "https://identity.example.test/realms/waypoint",
  "clientId": "registered-confidential-client",
  "clientSecretFile": "/run/secrets/oidc-client-secret",
  "requiredAcr": "provider-configured-mfa-context",
  "registryFile": "/run/secrets/registry.json"
}
```

The registry maps each customer UUID to `/run/customers/<UUID>/worker.sock` and a private `tokenFile` under the gateway's secret mount. That token must match only that customer's runtime token. Registry paths are operator input, never request input.

Customer configuration:

```json
{
  "org": "11111111-1111-4111-8111-111111111111",
  "project": "aaaaaaaaaaaaaaaaaaaa",
  "database": "/data/customer.sqlite",
  "keyFile": "/run/secrets/key",
  "tokenFile": "/run/secrets/token",
  "socket": "/run/runtime/worker.sock",
  "proxy": "http://egress:8080/bridge"
}
```

Session and customer envelope keys are independent 32-byte binary secrets. Runtime tokens are independent 64-character random hex values. Supply these through the approved secret-management deployment process; never commit them, pass them through browser forms, print them or copy an existing business credential. `secretFile` refuses group/world-readable files. On the Linux target, initialize `/data` as 0700 owned by its service UID and socket directories as 0770 owned by that customer's UID/GID. Provision secret files as 0400 owned by the specific reader UID (gateway and worker have separate token copies). Mount them read-only. Ordinary Compose bind mounts do not change ownership: verify it before starting. Customer data volumes start empty. Gateway UID is 10000; choose distinct customer UIDs from 10001–19999. A proper secret manager/KMS integration, rotation recovery and encrypted disks remain launch gates.

Build with the pinned Bun base image in `deploy/Dockerfile`, push the resulting application image to a private registry, and render using its digest. The deployment JSON contains `image`, `gatewaySecrets` and `customers` entries with `org`, `project`, `uid`, `secrets`. Run `bun deploy/isolation.ts deployment.json > compose.json`; inspect the rendered file and start under a new `wp-...` Compose project only. Never use an existing business Compose project name. Keep production configuration files out of the repo.

## Validation and remaining release work

Protocol tests exercise the real OIDC library with signed test-provider responses, including signature/state/nonce/PKCE/MFA failures and revocation. Container tests build the actual image and start two disposable runtimes. Database tests create a new Unix-socket-only PostgreSQL cluster; no existing database URL is used. This is reproducible non-production evidence. It does not establish provider integration, a live customer deployment, independent penetration testing or a SOC 2 report.

Before live onboarding: select and qualify the dedicated identity provider; register the final domain; provision secret management, TLS, encrypted storage and backup/restore; configure independent audit export/alerts, edge rate limits and firewall egress; obtain independent security review; and qualify one customer's staging bridge. Rate limiting in this implementation is bounded process-local admission, not a distributed abuse-control service. Audit tables are append-only to application commands, but the database owner can alter them; remote immutable retention is still required.

Sources checked for this implementation: [openid-client](https://github.com/panva/openid-client), [Docker security](https://docs.docker.com/engine/security/), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [function authorization](https://supabase.com/docs/guides/functions/auth-headers), and [October 2026 TLS notice](https://supabase.com/changelog/cbc-tls-ciphers-deprecated). Modern verified TLS is used; no legacy CBC dependency was added.

## Admission and telemetry limits

Anonymous requests use a bounded per-peer budget supplied by Bun’s `requestIP`, never a forwarded header. Valid sessions use a separate per-subject budget; public health/static reads do not consume it. If a reverse proxy is used, anonymous clients may share its transport address: configure verified edge admission separately. Denial audit records are sampled at no more than 16 rows per minute per process; they are not a complete request log. Authenticated grant/session events remain separate. Durable retention, capacity alerts and external immutable audit storage remain operator responsibilities.
