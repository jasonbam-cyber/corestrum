# Set up Corestrum on your Mac

**Installer pending.** These instructions are prepared for a future signed, notarized Mac release. The current source preview has no installer asset. Do not download third-party builds or bypass macOS security warnings.

## When the installer is available

1. Open the [official releases page](https://github.com/jasonbam-cyber/corestrum/releases). Under **Assets**, choose the Corestrum `.dmg` matching your Mac. “Source code (zip)” is for developers, not the installer.
2. To identify your Mac, choose **Apple menu → About This Mac**. Match its chip and macOS version to the release’s supported systems. Do not assume an Apple silicon download also supports Intel.
3. Open the downloaded `.dmg`. Drag **Corestrum Community** onto **Applications**.
4. Open **Applications**, then **Corestrum Community**. A normal downloaded-app confirmation is expected; an unidentified-developer, damaged-app or malware warning is not. Stop and report it instead of overriding security settings.
5. Create a vault passphrase of at least 14 characters. Save it in your password manager: Corestrum cannot recover it.
6. Start with **Getting started**. Meet the six roles and save a short business brief. Leave out passwords, payment details and customer identities.
7. In **Connections**, add your own supported AI account. API access may be billed separately from a chatbot subscription. Corestrum is free; AI usage is paid by you. The optional Claude Code connection needs a separate official installation and sign-in.
8. Load a practice prompt, review what will be sent, and send it to your agent. Review the result before using it. Routines start paused; enable only the ones you want.

No Terminal, Bun, Node or source checkout is needed for the packaged app. Connecting Supabase is optional and requires an administrator to install the scoped bridge; skip that connection to use briefs, AI drafts and routines.

## Keep your work safe

- Use **Lock workspace** when stepping away. Quitting stops local routines. The vault also locks after idle time.
- Use the encrypted backup controls before moving computers or updating. Keep your backup passphrase separately. Recovery does not copy AI keys, provider logins or Supabase credentials; reconnect those yourself. Restored routines stay paused.
- Community app data is stored in your Mac’s **Application Support/Corestrum Community** folder. Deleting the app does not delete that folder. Do not delete your data folder unless you intend to erase your work.
- Your business context goes to the AI provider you choose when you run an agent. Corestrum does not provide a hosted account or SOC 2 attestation.

## Updating

Quit Corestrum and make an encrypted backup first. Download a compatible signed release from the official page, replace the app in Applications, and reopen it. Follow any version-specific recovery instructions in the release notes. There is no automatic updater.
