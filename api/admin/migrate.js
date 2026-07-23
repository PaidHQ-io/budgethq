/**
 * MANUAL FALLBACK: applies db/schema.sql (BudgetHQ's own budgethq.* tables) using DATABASE_URL
 * from Vercel's own runtime env — same rationale as paidhq-core's identical endpoint
 * (api/admin/migrate.js there): Vercel's "sensitive" env vars are write-only once saved, so there's
 * no way to run db/migrate.js locally without the connection string ever being visible again.
 * Safe to call repeatedly — every statement in schema.sql is `create ... if not exists` (or an
 * idempotent drop/add pair for constraints on an existing table).
 *
 * AUTOMATED (2026-07-23): schema.sql now also runs automatically on every Vercel deploy via
 * db/migrate.js, wired into package.json's `vercel-build` script — see that file's doc comment.
 * This endpoint is kept as a manual escape hatch (e.g. to re-apply a schema change without waiting
 * on a full redeploy), not the primary way migrations happen anymore.
 *
 * Gated to Mo's accounts.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { sql } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { withApi } from "../lib/http.js";

const ADMIN_EMAILS = ["fractionalpaidmedia@gmail.com", "mo@refinelabs.com"];
const __dirname = dirname(fileURLToPath(import.meta.url));

export default withApi(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed — POST to run the migration." });
  }

  const { email } = await requireAuth(req);
  if (!ADMIN_EMAILS.includes((email || "").toLowerCase())) {
    return res.status(403).json({ error: "Not authorized" });
  }

  const schema = readFileSync(join(__dirname, "../../db/schema.sql"), "utf8");

  const sqlOnly = schema
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const statements = sqlOnly
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length);

  const ran = [];
  for (const stmt of statements) {
    await sql(stmt, []);
    ran.push(stmt.slice(0, 70).replace(/\s+/g, " "));
  }

  return res.status(200).json({ ok: true, statementsRun: ran.length, preview: ran });
});
