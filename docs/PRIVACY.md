# Data handling

Corestrum's default community workspace runs on your computer. There is no maintainer account, licensing callback, analytics integration or shared customer database in this path. Startup does not load `.env` files, discover cloud credentials or import other apps' data.

## Where data goes

| Action | Recipient and storage |
| --- | --- |
| Create/unlock workspace | Local passphrase vault; the passphrase is not sent to a server |
| Save brief, routine or report | Local SQLite; sensitive content is sealed with the vault key |
| Connect API key | The selected provider's model endpoint validates the key; the key is then stored encrypted locally |
| Run an AI role | Your chosen OpenAI/Anthropic API or your separately authenticated Claude Code receives the request, role instructions and business context |
| Connect Supabase | Only the project you explicitly configure, through the reviewed restricted bridge |
| Export backup | Encrypted business records, saved through your browser or native file dialog |
| Export evidence | Plaintext local event metadata; inspect it before sharing |

Providers apply their own retention, billing and account policies. Corestrum does not make a zero-retention promise on their behalf. The optional official Claude binary owns its own profile and credential storage; Corestrum does not extract subscription tokens.

## Local limits

Default source-run data is in `~/.corestrum-community`. The vault encrypts credentials; report text, business context and routine instructions are individually sealed. Routine names, timestamps, status, event names and resource identifiers are metadata in the local databases. Protect your disk and backups accordingly. Same-user software and administrators can inspect an unlocked process; these controls are not an OS sandbox.

A backup excludes provider keys, official Claude profiles, licenses, device keys, sessions and database connections. Restoring community data creates no access to the old installation's services. It preserves the new installation's local identity, reseals imported records and pauses all routines. Evidence hash chains cannot prove that an administrator did not replace the whole database.

To stop access, lock or quit the app, disconnect integrations and revoke grants/credentials at their original providers when needed. A local disconnect cannot erase an already processed provider request or revoke an official CLI login. Delete local files only after preserving any data you need; SQLite/WAL and system backups can retain historical encrypted bytes. There is no claim of secure erasure.
