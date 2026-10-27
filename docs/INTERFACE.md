# The Corestrum workspace

Corestrum uses forest and lime colors, translucent panels, soft edge lighting and a matching light appearance. Use the sun or moon button in the header to switch appearances. That preference is stored only in this browser; it is independent of your encrypted business data.

## Your pages

- **Getting started**: a five-step guide with six specialist lessons and practice requests. Exploring the guide never sends an AI request.
- **Overview**: recorded activity, your team, a draft composer, the shared business brief and routines.
- **Automations**: create, inspect, enable and pause routines. New routines remain paused.
- **Team**: each role, its purpose and a direct path to the composer.
- **Connections**: your AI provider, optional official Claude Code connection and scoped Supabase connection.
- **Evidence**: recorded activity, encrypted recovery, reports and activity export.

## What the charts mean

The activity chart counts recorded runs in your local calendar days. Switch between seven and fourteen days. Pointer hover, keyboard focus or a tap exposes the exact day and count. Runs include all recorded outcomes, not just completed drafts.

The API returns the latest **40 reports**. Both the activity chart and role breakdown use that limited snapshot; they are not an all-time business analytics service. The chart states its source and sample size. An empty workspace shows zero activity. Revenue, customer counts and compliance scores are never invented.

The draft count includes reports whose current state is `draft_ready`. Routine counts distinguish enabled and paused routines. “Activity chain: Intact” describes the local ledger integrity check, not a security audit or SOC 2 attestation.

## Motion and access

Panels enter as they reach the viewport; charts populate once on entry. Selected navigation moves between pages and eligible cards lift slightly under a fine pointer. Motion uses short opacity/transform transitions and does not delay action handlers.

System reduced-motion preferences remove entrance and chart animations. Keyboard navigation immediately reveals content and disables the moving navigation transition. Focus remains visible, page navigation returns keyboard focus to the workspace, and a skip link goes directly to the content. Reduced-transparency preferences replace translucent backgrounds with solid surfaces where supported.

No external image, font, chart, motion, analytics or design service is required by these interface changes. All fonts and assets are bundled locally. Authentication, encrypted storage, provider calls, account scope and routine scheduling retain their existing boundaries.
