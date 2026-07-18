/**
 * Postgres client for Vercel serverless functions.
 *
 * Uses @neondatabase/serverless instead of the standard `pg` package — `pg` holds a persistent
 * TCP connection per process, which doesn't play well with serverless functions that spin up and
 * tear down constantly (either exhausts the database's connection limit under load, or pays a
 * fresh TCP+TLS handshake on every cold start). Neon's driver talks HTTP/WebSocket instead, which
 * is built for exactly this environment — and it's what Vercel Postgres uses under the hood since
 * the Vercel/Neon partnership, so this works whether Mo provisions via Vercel's Storage tab
 * (env var comes in as POSTGRES_URL) or a standalone Neon project (DATABASE_URL).
 */
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!connectionString) {
  // Thrown lazily (inside sql(), not here) in most setups, but failing loud at import time makes
  // a missing env var obvious in the Vercel function logs instead of a cryptic query error.
  console.error("[db] Neither DATABASE_URL nor POSTGRES_URL is set — every query will fail.");
}

export const sql = neon(connectionString);
