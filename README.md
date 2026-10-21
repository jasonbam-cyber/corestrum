# Corestrum

**A free, open-source operations workspace for SaaS founders.** Bring your own AI, run the app locally, and turn your business context into practical reports, response drafts and routines you control.

Corestrum is an **Apache 2.0 source preview**. The community app has no Corestrum subscription, paid activation or licensing-server dependency. AI usage and any infrastructure you choose to run are billed by your own providers.

## What you can do

- Work with six AI roles: **Operations Lead, Support, Marketing, Bookkeeping, Legal and Compliance**. Each has a guided lesson and a practice prompt.
- Save a business brief, generate a focused report, ask the Operations Lead to coordinate specialist drafts, and revisit saved reports.
- Create scheduled routines. They start paused and run only when explicitly enabled, while the app is open and the vault is unlocked.
- Connect your own OpenAI or Anthropic API key. On macOS, optionally connect a separately installed official Claude Code through its own interactive authentication.
- Store credentials in a passphrase-encrypted vault; seal business briefs, report contents and routine instructions. Lock after 15 minutes without an authenticated owner action.
- Export encrypted business backups and restore into an empty community workspace. Credentials and third-party logins stay out; restored routines stay paused.
- Connect an explicitly scoped, **read-only Supabase bridge** to your own application. Installation signatures, account scope, replay checks and PostgreSQL RLS enforce the connection.
- Inspect local activity receipts and export evidence for your security program.

Agents produce drafts for owner review. They do not autonomously deploy apps, send customer emails, spend money, move funds, file legal documents or gain access to your other applications. Corestrum is an operations companion, not a replacement for your SaaS API, database or identity provider.

## Quickstart

Prerequisites: Git and [Bun 1.4.1](https://bun.com/docs/installation), a modern browser, and a trusted local computer. macOS is the primary local development target; Linux CI covers application tests. Native macOS packaging and the optional Claude connector have separate requirements. Windows is unqualified.

```sh
git clone https://github.com/jasonbam-cyber/corestrum.git
cd corestrum
bun install --frozen-lockfile --ignore-scripts
bun --no-env-file run dev
```

Open the URL in `~/.corestrum-community/launch-url.txt` in your browser. On macOS, from another terminal:

```sh
open "$(cat "$HOME/.corestrum-community/launch-url.txt")"
```

The app listens only on `http://127.0.0.1:4393`. The launch link is private and single-use: never paste it into an issue or share it. Create a vault passphrase of at least 14 characters, then follow **Getting started**. No remote account or payment is required. Save your brief, choose a role and connect your own AI only when you are ready to send it business context. Provider keys are validated against that provider; running agents can incur provider charges.

After the initial build, use `bun --no-env-file run start`. Stop the process with Ctrl-C. Routines do not run while it is stopped or locked. There is no always-on hosted service included.

For a separate business, stop the current process and use a separate private directory:

```sh
CORESTRUM_DATA_DIR="$HOME/.corestrum-another-business" bun --no-env-file run start
```

Do not point this at another app's data. There is no automatic import of browser sessions, cloud credentials or existing application databases. Use the documented `--no-env-file` commands to disable Bun’s automatic environment-file loading; your shell can still supply explicit environment settings. The default community command does not discover licensing configuration from the filesystem.

## Security and authentication

The local app uses a one-use bootstrap, an HTTP-only SameSite session, strict loopback host/origin checks, CSRF protection and a passphrase vault. Local HTTP is for the loopback-only process; do not tunnel or expose it to a network. Software running as your OS user and a compromised host remain outside these protections.

The separate self-hosted foundation includes OIDC authorization-code flow with PKCE, provider-enforced MFA checks, server-owned membership, viewer/owner roles, per-customer workers and scoped Supabase access. It needs **your own dedicated identity provider, secrets, deployment, ingress controls and qualification**. It is not enabled by the local quickstart. See [production authentication](docs/PRODUCTION-AUTH.md) and [architecture](docs/ARCHITECTURE.md).

**Corestrum is not SOC 2 certified or attested.** Its access controls and evidence tools can support readiness work. An organization's SOC 2 report requires its own controls, operating evidence and independent audit. AI legal/bookkeeping/compliance drafts are not professional advice or assurance.

See [SECURITY.md](SECURITY.md) for threat boundaries and private vulnerability reporting, and [privacy](docs/PRIVACY.md) for data recipients and storage limits.

## Development

```sh
bun run check
bun run guard:public
bun run build:production
bun audit
```

CI runs on GitHub-hosted runners without deployment credentials. It also tests disposable PostgreSQL privileges, RLS and licensing logic, and container isolation. The separate synthetic workflow demo is available with `bun run build && bun run demo:synthetic`; it contains fictional customers and deliberately selectable demo identities. Never connect it to real services.

The `api/` and `cloud/` directories retain the earlier optional Clerk/Stripe/device-entitlement reference implementation for developers studying or adapting it. They are not needed for the free community app and are not a hosted service offered by this repository. No maintainer credentials, production configuration, app data, private repository history or operational release records are included.

## Documentation

- [Architecture and feature boundaries](docs/ARCHITECTURE.md)
- [Data handling and privacy](docs/PRIVACY.md)
- [Connect your Supabase application](docs/SUPABASE-ONBOARDING.md)
- [Optional local Claude Code](docs/LOCAL-CLAUDE.md)
- [Encrypted recovery](docs/LOCAL-RECOVERY.md)
- [Self-hosted OIDC and customer isolation](docs/PRODUCTION-AUTH.md)
- [macOS packaging limitations](docs/MACOS-PACKAGING.md)
- [Contributing](CONTRIBUTING.md)

## Distribution and license

This release distributes **source**, not a signed/notarized desktop installer or a managed backend. No production-readiness or independent penetration-test guarantee is made. Review and qualify your deployment before connecting sensitive or customer data.

Original Corestrum source is licensed under [Apache License 2.0](LICENSE). You may use and modify it commercially under that license. Dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). Redistributing a compiled Bun-based app requires artifact-specific dependency notices and source/relink review; the included runtime overview alone is not clearance.
