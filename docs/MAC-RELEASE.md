# Maintainer: signed Mac release

This is a release procedure, not evidence that a signed installer exists. Do not publish an ad-hoc qualification image. Keep signing keys and notarization credentials in the authorized Mac’s Keychain, never in this repository or public CI.

## Prerequisites

- The reviewed source commit and its exact successful CI run.
- An existing, valid **Developer ID Application** identity with its matching private key (`security find-identity -v -p codesigning`). A downloaded public certificate alone is insufficient. Do not revoke certificates used by other apps.
- Notarization access stored interactively in a dedicated Keychain profile. Run `xcrun notarytool store-credentials corestrum-notary` in your own Terminal and answer its secure prompts. Never put an Apple password, app-specific password or API private key in source, shell history, logs or chat. Do not reuse another app’s profile without authorization.
- Reviewed redistribution materials for the exact bundled runtime. The current `packaging/notices/bun-runtime.json` explicitly records incomplete native/source/relink materials; this gate is still open.
- An independent Mac for downloaded, quarantined installation testing, covering the hardware and macOS version advertised in the release.

For an individual Apple membership, the signer’s registered name is visible in the distributed certificate. Confirm the intended public publisher identity before signing. Account agreements and credential/Keychain prompts must be completed by the account holder.

## Build and qualify

Build from a clean checkout on macOS. Use an untracked release configuration containing only `{"edition":"community"}`. The package script accepts a new absolute output directory and `--identity` with the exact existing Developer ID Application name. It signs the native app and bundled runtime with hardened runtime and a secure timestamp. It does not notarize or certify customer readiness.

Run the copied-DMG process checks with `python3 scripts/test-macos-package.py --package-evidence /absolute/output/package-evidence.json --output /absolute/new-test-output`. These checks use fictional workspaces and no provider credentials. Passing on the builder Mac is not independent Gatekeeper acceptance.

## Notarize the app and final disk image

Use the reviewed package paths below in place of placeholders; do not submit an ad-hoc preview.

1. Create a ZIP of the signed `.app` using `ditto -c -k --keepParent`, then submit it with `xcrun notarytool submit /absolute/app.zip --keychain-profile corestrum-notary --wait --output-format json`. Retain the submission ID and require status **Accepted**. On rejection, retrieve the log for that ID and fix the actual issue.
2. Run `xcrun stapler staple /absolute/Corestrum\ Community.app` and `xcrun stapler validate` on the same app. Verify `codesign --verify --deep --strict` and `spctl --assess --type execute --verbose=4`. Never change Gatekeeper settings to make a test pass.
3. Recreate the DMG from the layout containing the stapled app, Applications shortcut and finalized simple setup instructions. Use a new filename; do not silently overwrite the pre-notarization artifact. Sign the final DMG with the same Developer ID identity and a secure timestamp.
4. Submit the final DMG with `notarytool`, require **Accepted**, staple it and validate the ticket. Assess it with `spctl --assess --type open --context context:primary-signature --verbose=4`.
5. Recompute SHA-256 and bundle inventory **after** all signing and stapling. The original build receipt’s hashes are now stale. Record both submission IDs, final hashes, actual architecture, minimum OS, signer/team and the source commit in a separate final release receipt.
6. Test a browser-downloaded copy on an independent clean Mac with default Gatekeeper: open DMG, drag to Applications, create vault, save a fictional brief, lock, quit and reopen. Verify no developer tools are needed and no unexpected egress occurs. Test explicit provider connection separately using an authorized test account.
7. Only after all gates pass, upload the exact final DMG, checksum and plain-language setup guide to the GitHub release. Remove the guide’s pending notice only when the asset exists. Read back the release asset size/digest and download it to verify the final hash. Do not upload Keychain exports, account profiles, private signing logs or credentials.

An Apple silicon build does not prove Intel support. Retain earlier signed versions for rollback; this app has no automatic updater.

Apple references: [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/), [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [customizing the workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
