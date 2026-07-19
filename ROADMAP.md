# BudgetHQ / PaidHQ Roadmap / Parking Lot

Rolling backlog of features to build next. Update this file as items are started/shipped or new ideas come up — treat it as the source of truth to refer back to across sessions, separate from the in-chat task widget (which only reflects the current session).

## Pending setup (code already built, needs account/config work — not dev work)

- **Microsoft login** — button live in Auth.jsx. Needs an Azure App Registration + client secret pasted into Supabase's Azure provider settings.
- **LinkedIn login** — button live in Auth.jsx (`linkedin_oidc`). Needs a LinkedIn Developer app + client secret pasted into Supabase's LinkedIn (OIDC) provider settings.
- **Facebook login** — button live in Auth.jsx. Needs a Meta for Developers app + client secret pasted into Supabase's Facebook provider settings. Facebook additionally requires App Review before it works for anyone beyond your own test users.
- **Google Sheets export** — code shipped. Needs: Sheets API enabled + `spreadsheets` scope added in the "PaidHQ" Google Cloud project, `VITE_GOOGLE_CLIENT_ID` env var on Vercel, and the deployed origin added to that OAuth client's Authorized JavaScript origins. Same Testing-mode cap as Facebook applies until Google verification is done.

## Backlog

1. **Spreadsheet-style redesign of Budget, Tagger, and Reporting & Pacing tabs** — make these views look/feel more like Google Sheets or Excel (grid lines, cell-based interaction, familiar spreadsheet affordances) rather than the current card/table styling.
2. **Finish "export to Google Sheets / Excel Online"** — one-shot "create a new file" export shipped for Google Sheets (Dashboard, Tagger, Budget, Pacing → "···" menu). Remaining: Excel Online (Microsoft Graph API) equivalent export.
3. **Append to an existing Google Sheet / Excel file** — current export always creates a brand-new file. Add a mode to pick an existing spreadsheet and append/update rows in it instead (for recurring reporting into the same tracker file).
4. **LinkedIn bulk export enrichment tool** — Mo has the underlying data/spec from another chat; needs to be pulled in when this is picked up.
5. **Inline field/column creation** — add new columns directly within the table UI, spreadsheet-style, instead of only through the existing dimension-management UI.
6. **Inline formulas** — support Sheets/Excel-style formulas on computed columns/cells.
7. **Proactive alerts (Phase 3)** — Slack + email notifications on budget pacing issues. Originally picked as the most exciting next feature (before the multi-tenant backend work took priority); `budgethq.alert_rules` table already scaffolded in the schema, nothing built on top of it yet. Needs Vercel Cron + Slack/email delivery.
8. **Enterprise SSO (SAML/OIDC)** — for enterprise clients whose IT requires it. Needs a paid Supabase plan (not available on Free tier) and per-client configuration against their specific identity provider (Okta, Azure AD, etc.). Deliberately not built speculatively — build when a real enterprise client asks for it.
9. **Pricing tiers, billing, and checkout (Stripe)** — required to actually sell BudgetHQ/PaidHQ access. `core.entitlements` table already supports plan/status per workspace-product, currently only settable manually via API (used today just to grant free trials on signup). Needs: Stripe product/price setup, checkout flow, webhook handler to keep entitlements in sync with subscription status, and a billing/upgrade UI.

## Longer-term / known but not scheduled

- Building out VaultHQ, ReportingHQ, and AuditHQ themselves on top of the paidhq-core foundation (currently only BudgetHQ is a real product on the platform).

## Status

Logged 2026-07-18. Google login is fully live; Microsoft/LinkedIn/Facebook buttons are built but need provider setup (see above). Nothing else in this list started yet.
