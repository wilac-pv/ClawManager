# PG migration assets

This directory holds PostgreSQL-specific assets for the skill-market-server
SQLite → Postgres migration. These files are **not** part of the SQLite
migration chain (the `0XX_*.sql` files in the parent directory) and must not
be loaded by the SQLite `loadMigrations` runner.

## State discovered 2026-08-06

The target PG instance (`10.255.46.231:9999`, db `claw_pgsql`) is a pooled
proxy to backend `10.255.46.4:5432` (Postgres 16.9). It carries **four parallel
schemas**, each with the full 26-table layout:

| schema | role | data | indexes |
|---|---|---|---|
| `public` | empty primary layout | 0 rows | 21 |
| `skill_market_stage` | **active data** | 110k import_items, latest 8/5 13:35 | 21 → 34 after this migration |
| `skill_market_stage2` | snapshot/replica | 110k rows, same freshness | 0 |
| `skill_market_stage3` | snapshot/replica | 110k rows, same freshness | 0 |

The role `claw_pgsql` has `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER`
and the default `search_path` points at `skill_market_stage`, so unqualified
table names resolve there. **The application must connect with the same
`search_path=skill_market_stage` (or use `SET search_path`) to reach the live
data.**

## `001_missing_indexes.sql`

Adds the 13 indexes that the upstream import tool (`idx_83xxx_*`) did not carry
over from the SQLite `.schema`. Already applied to `skill_market_stage` on
2026-08-06; `EXPLAIN` confirms `idx_skillhub_import_queue` is used for the
queue scan over the 110k-row table (Index Scan, no Seq Scan).

## Still pending

- **CHECK constraints** were dropped during import (0 in PG vs ~40 in SQLite).
  The SQLite rules include `state IN (...)` enums, `version >= 1`, `length()`
  bounds, and `json_valid()` checks. PG equivalents need either native `enum`
  types or `CHECK`, and the `json_valid()` columns should become `jsonb`.
  This is deferred because it changes column types and needs a coordinated
  data backfill, not a blind `ALTER TABLE`.
- **NOT NULL** was lost on several columns (e.g. `submissions.skill_id` is
  nullable in PG but `NOT NULL` in SQLite) — needs an audit pass.
- **stage2/stage3** have no indexes; if they become live, re-run this file
  there with the right `search_path`.
