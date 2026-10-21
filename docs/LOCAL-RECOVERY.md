# Encrypted business recovery

In **Evidence**, choose a backup passphrase of 16–256 characters, confirm it and save the encrypted file somewhere independent of this computer. Keep the passphrase separately. The app cannot recover a forgotten passphrase.

The archive contains a fixed schema: business context, routine definitions, report contents and local activity chain. It excludes provider credentials, Claude profiles, database connections, device keys, licenses and sessions. AES-256-GCM uses a fresh salt/IV and a scrypt-derived key. Preview bounds are 4 MiB plaintext and 6 MiB encrypted archive.

For the free community app, create an empty private workspace and unlock it, then select the archive, enter its passphrase and explicitly confirm restore. Import validates the archive and writes in one SQLite transaction. Data is resealed with the new vault; the new local workspace identity stays unchanged. Existing business data is never overwritten. Imported routines remain paused and interrupted reports become unknown outcomes. Reconnect your own providers before enabling anything. Possession of an encrypted archive and its passphrase authorizes importing its business records; it conveys no provider or remote account authority.

Optional legacy licensed installations require activation for the same business and reject a foreign-workspace archive. Community import does not relax that check.

Newer readers store the brief in encrypted SQLite `local_settings`. Earlier readers may not see a saved/restored brief. Preserve a current reader and an encrypted export before switching versions; do not assume a downgrade is compatible. This source preview has no automatic updater, overwrite restore, cloud backup or recovery of lost provider access.

A local hash chain is useful for detecting changes relative to an independently retained export. It is not immutable against the database owner or independent audit attestation.
