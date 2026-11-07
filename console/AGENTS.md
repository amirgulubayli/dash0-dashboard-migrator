<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules
- All report.json field names and parsing live only in `src/lib/report.ts`; the CLI may rename fields, so this keeps renames to one file.
- The app is browser-only: no backend, no network calls, no AI, no translation logic (hackathon rule: translation must be deterministic in the CLI).
- Review decisions are stored in localStorage keyed by the SHA-256 of the loaded report text, so decisions never carry across reports.
- The map packs groups in file order into 12-column bands (Datadog group `y` values restart); widgets keep their relative grid inside the group.
- Items and Review share the same detail drawer and decision controls so edits remain consistent with the map.
- Derive widget categories and optional claim fidelity in report.ts so report field changes remain centralized.
- Review queue ordering lives in a browser-safe helper and exports validate decision eligibility and check-rule ticks to prevent invalid sign-off.
- Display-only type tags and short reason labels live in `src/lib/presentation.ts`; parsing remains centralized and independent of styling.
- Bulk acknowledgement eligibility lives with review queue helpers and only permits nonempty unsupported/no-equivalent widget groups; every decision still passes the shared store validation.
- Map presentation collapses redundant source row boundaries and halves note tiles while retaining file-order bands and relative horizontal positions, so the projector view fits without changing parsed geometry.
- Shared detail supports stacked map and three-column drawer layouts; query text breaks only at explicit whitespace/operator opportunities to preserve metric names.

## Handover rules
- Browser-only. No AI calls and no network calls (the only fetch is the same-origin `/report.json` from the public folder).
- All report parsing and `report.json` field names live only in `src/lib/report.ts`.
- Every number shown is computed from the loaded file; never hard-code counts.
- Never show confidence scores.
- `review.json` keeps `report_sha256` and the `approved` / `flagged` / `acknowledged` decision values unchanged.
- Package manager is Bun (`bun.lock`). Work on a branch, not `main`.
