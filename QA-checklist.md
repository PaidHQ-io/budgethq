# BudgetHQ end-to-end QA checklist

Code-level audit is done — no bugs found in the core import/sync/tagging/pacing logic. This checklist is for verifying the same flow with your real data in the live app (budget.paidhq.io). Two things below are flagged as **watch closely**, not code bugs — they're places where a data-entry mismatch can silently break pacing with no error message.

---

## 1. Budget upload with required segments

- [ ] Import your budget file (Budget Panel → Import CSV/Excel).
- [ ] Confirm every segment dimension you need (Product, Region, Funnel, Pillar, BU, etc.) got mapped in the column-mapping step — not just the ones that happened to auto-detect.
- [ ] Check the preview table before confirming: row count matches what you expect, and dollar amounts landed in the right months.
- [ ] After import, spot-check a few segment rows in the Budget Panel table against the source file.
- [ ] If you re-import the same file later with additional or fewer segments mapped, confirm the merge-review or contraction-warning modal appears as expected rather than silently duplicating rows.

**Watch closely:** the exact spelling/capitalization of each segment value here (e.g. "LinkedIn" vs "linkedin", "Brand" vs "Brand ") is what step 3's tagging has to match *exactly* for pacing to work. Decide on canonical spellings now, before tagging.

## 2. LinkedIn sync / CSV upload (campaigns + ad sets/ad groups)

- [ ] Sync LinkedIn for a known date range and confirm the campaign count and total spend roughly match what you see in LinkedIn's own Campaign Manager for that range.
- [ ] Confirm Campaign Group and Campaign show as two distinct columns in the Tagger (not duplicated values) — this was a bug fixed earlier this session, worth a final glance.
- [ ] Upload a CSV from another platform (Meta/Google/Bing) and confirm the auto-detected columns are right, especially Campaign vs Campaign Group, before hitting Continue.
- [ ] Re-sync/re-upload the same range again and confirm it merges (updates existing rows) rather than duplicating spend.

**Watch closely — LinkedIn sync date granularity:** live-synced LinkedIn spend is pulled at monthly granularity and stamped on the 1st of each month (LinkedIn's Advertising API tier doesn't expose daily breakdowns here). That means mid-month, the pacing engine sees the *whole* month's spend as already landed on day 1, which can make LinkedIn segments look artificially "ahead of pace" early in a month and then flat for the rest of it. This doesn't affect the totals — just the shape of the daily run-rate/projection for LinkedIn specifically. CSV-uploaded LinkedIn exports with real daily dates don't have this issue.

## 3. Tagging alignment with budget segments (+ extra dimensions like Region, Funnel)

- [ ] Tag a batch of campaigns with the same dimensions used in the budget upload, and confirm they show up correctly in the Budget Panel / Pacing view (spend rolling up under the right segment).
- [ ] Tag a batch with an *additional* dimension not in the budget (e.g. Region when budget is only Product+Pillar) and confirm it doesn't break the budget-level roll-up — extra dimensions should just ride along for drill-down/filtering.
- [ ] Deliberately test a mismatch: tag one campaign with a slightly different spelling than the budget segment (e.g. lowercase) and confirm you see it fall into "No budget set" in Pacing — that's the failure mode to watch for in real usage, not a bug, just confirming the behavior so you recognize it if it happens for real.

**Watch closely:** the "Apply tag" value field in the Tagger is free text, not constrained to your existing budget segment values — there's no autocomplete or typo-catching built in yet. A stray space or capitalization difference will silently show as "No budget set" in Pacing with no warning. Worth being deliberate about spelling consistency here, especially with multiple people tagging.

## 4. Pacing and projection review (by product/segment and breakdown)

- [ ] Pick a segment with a full month or more of spend and sanity-check the numbers: Actual Spend, % of Budget Used, Daily Run Rate, Projected Year-End Spend against what you'd calculate by hand.
- [ ] Check a segment early in its period (e.g. first few days of a new month/quarter) — projections here will look volatile since they're a simple linear extrapolation (spend-so-far ÷ days-so-far × total days). That's expected behavior, not a bug — projections stabilize as more of the period elapses.
- [ ] Use the breakdown drill-down (by Platform or another dimension) on a segment and confirm the percentages sum to 100% and match the segment total.
- [ ] Check a segment with genuinely no spend yet and confirm it shows "No budget set" or the correct zero-state rather than an error.

## 5. Overspend/underspend threshold flagging — not built yet

This is intentionally out of scope for this QA pass. Today, pacing status (Over budget / Ahead of pace / On track / Behind pace) uses a fixed ±10 percentage point threshold against expected pace, with no separate "flag" or alert layer. When you're ready to scope configurable thresholds, useful questions to have answers to going in: should thresholds be global or per-segment/per-product, should "flagged" trigger anything beyond a visual badge (email digest, dashboard count), and should the threshold be a percentage-of-pace (like today) or a dollar-variance amount.
