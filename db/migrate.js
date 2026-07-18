/**
 * One-time (and re-runnable) schema migration script. Run with:
 *   DATABASE_URL="..." node db/migrate.js
 * or, if DATABASE_URL/POSTGRES_URL is already in your shell env (e.g. pulled via
 * `vercel env pull`), just:
 *   node db/migrate.js
 *
 * IMPORTANT: run paidhq-core's own db/migrate.js FIRST, against the same DATABASE_URL — this
 * schema's tables foreign-key against core.workspaces, which has to exist before these tables can
 * be created.
 *
 * schema.sql is written entirely with `create table if not exists` / `create index if not
 * exists`, so this is safe to run again after future schema changes without dropping data.
 *
 * Uses the plain `pg` package rather than @neondatabase/serverless. That package's fast paths
 * (the neon() HTTP tagged-template function, and its WebSocket-based Client/Pool) are built for
 * edge/serverless runtimes and need extra configuration to work in an ordinary local Node.js
 * process — not worth fighting for a script you run by hand a handful of times. `pg` connects over
 * plain TCP+SSL, which is all a Neon database needs and works everywhere with zero setup. The
 * deployed API routes keep using @neondatabase/serverless's neon() — that one's genuinely built
 * for the serverless-function environment it runs in.
 */
import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!connectionString) {
  console.error("Set DATABASE_URL or POSTGRES_URL before running this script.");
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");

// Strip full-line `--` comments FIRST, then split what's left on statement-terminating
// semicolons. Splitting on semicolons before removing comments breaks if a comment's prose
// text itself contains a semicolon — the split would cut the file mid-comment and leave a
// fragment that doesn't start with `--`, so it'd get sent to Postgres as if it were real SQL.
// Removing whole comment lines up front avoids that class of bug entirely, regardless of what
// punctuation shows up in comment prose.
const sqlOnly = schema
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const statements = sqlOnly
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length);

for (const stmt of statements) {
  console.log(`Running: ${stmt.slice(0, 70).replace(/\s+/g, " ")}...`);
  await client.query(stmt);
}

console.log(`Done — ran ${statements.length} statements.`);
await client.end();
