# Third-party materials

The Apache-2.0 license applies to original Corestrum source. Dependencies retain their respective licenses; installing or bundling them does not relicense them.

JavaScript and font dependency versions are pinned in `bun.lock`. `scripts/desktop-notices.ts` collects their actual installed license files when making a desktop package. The generated inventory includes React, React DOM, Clerk, jose, lucide-react, openid-client, postgres, Stripe, Inter and the runtime overview as applicable to the build.

Bun is installed separately for the source quickstart. This repository does not distribute a Bun executable or a prebuilt app. `packaging/notices` retains the pinned upstream runtime overview used by the packaging tooling; it is not a complete native dependency inventory, SBOM or redistribution clearance. Anyone distributing compiled executables must qualify the exact runtime/dependency notices, corresponding-source and relink obligations, and distribution rights for their artifact. The packaging receipt deliberately leaves `redistributionCleared: false`.

Do not remove upstream copyright, license or attribution files. A build or passing test is not legal redistribution clearance.
