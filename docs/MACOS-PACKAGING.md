# macOS packaging

The public quickstart runs source through Bun and a browser. This repository does not publish a signed/notarized installer. Native AppKit/WebKit source and packaging tools are included for developers; their output requires separate review before distribution.

The native host supervises a loopback Bun executable, keeps its workspace private, manages the process lifecycle and exports through an explicit native Save dialog. Build on macOS with the appropriate Apple command-line tools and the locked dependencies. Use a new absolute output directory.

For a free community package, create an untracked configuration file containing only:

```json
{ "edition": "community" }
```

Pass its absolute path as `--release-config` to `bun run package:macos`, along with `--output` and the signing options described by `scripts/package-macos.ts`. The output targets the build Mac’s architecture. A local qualification build uses `--qualification`; it is ad-hoc and is not approved for end-user installation. Do not bypass Gatekeeper or reuse another application's signing credentials. The community package's native data directory is separate from licensed installations.

Publishing a downloadable installer requires an appropriate Developer ID, notarization, clean-machine Gatekeeper acceptance, tested hardware/OS support, upgrade/recovery compatibility and complete notices/source/relink materials for the exact runtime. The packaging receipt retains `customerReady: false` and `redistributionCleared: false` until those requirements are independently resolved. Source tests do not satisfy them.

The optional legacy licensed configuration contains only a public verifier, environment and HTTPS cloud origin. Never embed a signing key, provider credential, account profile or customer data in a package.
