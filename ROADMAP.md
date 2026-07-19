# BudgetHQ Roadmap / Parking Lot

Rolling backlog of features to build next. Update this file as items are started/shipped or new ideas come up — treat it as the source of truth to refer back to across sessions, separate from the in-chat task widget (which only reflects the current session).

## Backlog

1. **Spreadsheet-style redesign of Budget, Tagger, and Reporting & Pacing tabs** — make these views look/feel more like Google Sheets or Excel (grid lines, cell-based interaction, familiar spreadsheet affordances) rather than the current card/table styling.
2. **Finish "export to Google Sheets / Excel Online"** — one-shot "create a new file" export already shipped (Dashboard, Tagger, Budget, Pacing → "···" menu → Export to Google Sheets). Remaining: Excel Online (Microsoft Graph API) equivalent export.
3. **Append to an existing Google Sheet / Excel file** — current export always creates a brand-new file. Add a mode to pick an existing spreadsheet and append/update rows in it instead (for recurring reporting into the same tracker file).
4. **LinkedIn bulk export enrichment tool** — Mo has the underlying data/spec from another chat; needs to be pulled in when this is picked up.
5. **Inline field/column creation** — add new columns directly within the table UI, spreadsheet-style, instead of only through the existing dimension-management UI.
6. **Inline formulas** — support Sheets/Excel-style formulas on computed columns/cells.

## Status

Nothing in this list started yet — logged 2026-07-18, right after shipping the first Google Sheets export.
