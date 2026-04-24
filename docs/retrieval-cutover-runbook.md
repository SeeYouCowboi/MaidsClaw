# Retrieval Cutover Runbook

Migration: legacy `pg_trgm` / `ILIKE` search-doc backend to ParadeDB `pg_search` BM25 + alias exact + embedding hybrid.

Container: `maidsclaw-app-pg`. Database: `maidsclaw_app`. User: `maidsclaw`.
Pinned image today: `paradedb/paradedb:0.23.0-pg17` from `docker-compose.pg.yml`.

Scope note: `search_docs_private` has been retired; private retrieval now routes through the typed cognition / episode surfaces rather than a mixed private search-doc table.

---

## 0. Version Capture

Run after the ParadeDB image is up to record exact extension versions in commit evidence:

```bash
docker exec "maidsclaw-app-pg" psql -U maidsclaw -d maidsclaw_app -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('pg_search','vector','pg_trgm');"
```

Expected: `pg_search` and `vector` must be present with non-empty `extversion`. `pg_trgm` may still be present because non-search-doc helper logic can continue to use trigram similarity after the search-doc cutover.

---

## 1. Pre-Cutover Backup

### 1a. Create the backup directory

Run from `D:\ACodingWorkSpace\MaidsClaw`:

```powershell
pwsh -Command "New-Item -ItemType Directory -Force '.local-backups\retrieval-cutover' | Out-Null"
```

### 1b. Dump truth tables

This command dumps only the 22 truth-plane tables. Derived tables are intentionally excluded because they are safe to rebuild.

```bash
docker exec "maidsclaw-app-pg" pg_dump \
  -U maidsclaw -d maidsclaw_app \
  --table=settlement_processing_ledger \
  --table=event_nodes \
  --table=logic_edges \
  --table=topics \
  --table=fact_edges \
  --table=entity_nodes \
  --table=entity_aliases \
  --table=pointer_redirects \
  --table=core_memory_blocks \
  --table=memory_relations \
  --table=private_episode_events \
  --table=private_cognition_events \
  --table=area_state_events \
  --table=world_state_events \
  --table=scene_area_fact_events \
  --table=scene_world_fact_events \
  --table=shared_blocks \
  --table=shared_block_sections \
  --table=shared_block_admins \
  --table=shared_block_attachments \
  --table=shared_block_patch_log \
  --table=shared_block_snapshots \
  -f /tmp/truth-backup.sql
```

### 1c. Copy the dump to local storage

```bash
docker cp maidsclaw-app-pg:/tmp/truth-backup.sql \
  .local-backups/retrieval-cutover/truth-backup.sql
```

Expected artifact: `.local-backups/retrieval-cutover/truth-backup.sql` (non-zero size).

---

## 2. Restore Smoke Procedure

After creating the backup, verify it restores cleanly into a fresh database before proceeding with any destructive step.

### 2a. Create the smoke database

```bash
docker exec "maidsclaw-app-pg" psql \
  -U maidsclaw -d postgres \
  -c "DROP DATABASE IF EXISTS maidsclaw_app_restore_smoke"

docker exec "maidsclaw-app-pg" psql \
  -U maidsclaw -d postgres \
  -c "CREATE DATABASE maidsclaw_app_restore_smoke WITH OWNER maidsclaw"
```

### 2b. Restore the dump

On Linux/macOS:

```bash
docker exec -i "maidsclaw-app-pg" psql \
  -U maidsclaw -d maidsclaw_app_restore_smoke \
  < .local-backups/retrieval-cutover/truth-backup.sql
```

On Windows (PowerShell):

```powershell
Get-Content ".local-backups\retrieval-cutover\truth-backup.sql" |
  docker exec -i "maidsclaw-app-pg" psql -U maidsclaw -d maidsclaw_app_restore_smoke
```

Note: errors about `fn_deny_delete_*` and `fn_deny_update_*` trigger functions not existing are expected. The selective `--table` dump does not include those functions. The table data and structure are intact.

### 2c. Verify row counts in the smoke database

```bash
docker exec "maidsclaw-app-pg" psql \
  -U maidsclaw -d maidsclaw_app_restore_smoke \
  -c "SELECT relname AS table_name, n_live_tup AS row_count
      FROM pg_stat_user_tables
      ORDER BY relname;"
```

Gate: all 22 truth tables must appear. Row counts must match or exceed the baseline values recorded in `docs/retrieval-baseline.md`. Any missing table or unexpected zero row count on a table that had rows at backup time is a hard stop.

### 2d. Spot-check key tables

```bash
docker exec "maidsclaw-app-pg" psql \
  -U maidsclaw -d maidsclaw_app_restore_smoke \
  -c "SELECT COUNT(*) FROM private_episode_events;
      SELECT COUNT(*) FROM private_cognition_events;
      SELECT COUNT(*) FROM entity_nodes;"
```

### 2e. Drop the smoke database when done

```bash
docker exec "maidsclaw-app-pg" psql \
  -U maidsclaw -d postgres \
  -c "DROP DATABASE IF EXISTS maidsclaw_app_restore_smoke"
```

---

## 3. Optional: Derived Cache Backup

The four derived-cache tables (`node_embeddings`, `semantic_edges`, `graph_nodes`, `node_scores`) are rebuilable from truth data using `scripts/memory-rebuild-derived.ts --re-embed`. Backing them up is optional but saves time if the embedding model is slow or if you want a fast rollback path that avoids re-embedding.

### When to back up the derived cache

- The embedding model is large and slow to run locally.
- You want to test the new pg_search index without triggering a full re-embed.
- You are doing an in-place PG upgrade (no volume wipe) and want a rollback snapshot.

Skip the derived cache backup if:

- You plan to wipe the volume entirely (derived cache will be rebuilt from scratch anyway).
- You are on a fast machine with a cached model and re-embedding takes less than a few minutes.

### Derived cache backup commands

```bash
docker exec "maidsclaw-app-pg" pg_dump \
  -U maidsclaw -d maidsclaw_app \
  --table=node_embeddings \
  --table=semantic_edges \
  --table=graph_nodes \
  --table=node_scores \
  -f /tmp/derived-cache-backup.sql

docker cp maidsclaw-app-pg:/tmp/derived-cache-backup.sql \
  .local-backups/retrieval-cutover/derived-cache-backup.sql
```

### Derived cache rebuild commands (without backup)

If you did not back up the derived cache, rebuild after cutover:

```bash
# Rebuild search projections
bun run scripts/search-rebuild.ts --agent <agentId> --scope all

# Rebuild current-state projections and re-embed
bun run scripts/memory-rebuild-derived.ts --agent <agentId> --re-embed
```

---

## 4. Cutover Gate Criteria

All of the following must pass before declaring the cutover complete.

| Gate | Command | Pass condition |
|---|---|---|
| Build clean | `bun run build` | Zero errors |
| Data-plane tests | `bun run test:pg:data-plane` | All tests green |
| Memory unit tests | `bun test test/memory/query-tokenizer.test.ts test/memory/retrieval-trace-capture.test.ts` | All tests green |
| Golden set recall | Run queries from `test/fixtures/retrieval-golden-set.json` | All `expected_top_ref` cases hit within `recall_k` |
| cross-agent leakage | `cross-agent-leakage` case in golden set | 0 results from wrong agent scope |
| alias exact hit | `alias-exact` and `pointer-key-exact` cases | Target episode is top result |
| p95 latency | Manual or instrumented query | Within acceptable local range |
| Restore smoke | Section 2 above | All 22 tables present, row counts match |

---

## 5. Rollback Triggers

Initiate rollback if any of the following occur after cutover:

- `bun run build` produces TypeScript errors not present before cutover.
- `bun run test:pg:data-plane` has new failures that were not failing before.
- Any golden set case that passed at baseline now fails recall at the same `recall_k`.
- `cross-agent-leakage` golden case returns non-zero results.
- Any truth-plane table has fewer rows than the backup snapshot.
- pg_search BM25 index corruption is detected (index returns errors or crashes the connection).
- pg_search boot failure (extension/index init fails during startup migration/bootstrap).
- Restore smoke verification fails after rollback rehearsal.
- Dashboard contract drift against retrieval trace contract is detected.
- Benchmark gate breach: `cross_agent_leakage_count > 0` or `p95_ms > 300`.

### Rollback

#### Step 1 — Snapshot cutover point tag (`pre-pg-search-cutover`)

Before final cutover, create (or verify) the local rollback anchor tag:

```bash
git tag -a pre-pg-search-cutover -m "Pre pg_search cutover rollback anchor"
```

If the tag already exists, verify it points at the intended commit:

```bash
git show --no-patch pre-pg-search-cutover
```

#### Step 2 — Restore truth-plane backup artifact

Primary rollback artifact path:

```
.local-backups/retrieval-cutover/truth-backup.sql
```

Restore commands:

```bash
docker exec "maidsclaw-app-pg" psql -U maidsclaw -d postgres \
  -c "DROP DATABASE IF EXISTS maidsclaw_app"
docker exec "maidsclaw-app-pg" psql -U maidsclaw -d postgres \
  -c "CREATE DATABASE maidsclaw_app WITH OWNER maidsclaw"
```

On Windows (PowerShell):

```powershell
Get-Content ".local-backups\retrieval-cutover\truth-backup.sql" |
  docker exec -i "maidsclaw-app-pg" psql -U maidsclaw -d maidsclaw_app
```

#### Step 3 — Revert container image to pre-ParadeDB

Revert `docker-compose.pg.yml` to the pre-ParadeDB image from the rollback anchor:

```bash
git checkout pre-pg-search-cutover -- docker-compose.pg.yml
docker compose -f docker-compose.pg.yml up -d maidsclaw-app-pg
```

#### Step 4 — Run restore-smoke verification

Run Section 2 (Restore Smoke Procedure) end-to-end and block release unless it passes.

### Legacy rollback procedure (expanded)

1. Stop the application server.
2. Drop the database or restore from backup.

   ```bash
   # Option A: restore from truth backup
   docker exec "maidsclaw-app-pg" psql -U maidsclaw -d postgres \
     -c "DROP DATABASE IF EXISTS maidsclaw_app"
   docker exec "maidsclaw-app-pg" psql -U maidsclaw -d postgres \
     -c "CREATE DATABASE maidsclaw_app WITH OWNER maidsclaw"

   # On Windows (PowerShell):
   Get-Content ".local-backups\retrieval-cutover\truth-backup.sql" |
     docker exec -i "maidsclaw-app-pg" psql -U maidsclaw -d maidsclaw_app

   # Option B (if no volume wipe): revert ParadeDB image, restart container
   ```

3. Rebuild derived tables (section 3 above).
4. Re-run gate criteria from section 4 before re-attempting cutover.

### Additional rollback triggers from Phase 4 plan

- Golden set critical case failure (any `expected_top_ref` miss within `recall_k`).
- Cross-agent leakage count > 0.
- Benchmark `p95_ms > 300`.
- Dashboard contract drift.

---

## 6. Post-Cutover Cleanup

After a successful cutover and a soak period of at least one session run:

- Delete the smoke database if it was left behind.
- Optionally archive `.local-backups/retrieval-cutover/truth-backup.sql` to a durable location.
- Update `.maidsclaw-version` in `Maids-Dashboard` if the container image changed.
- Record any regressions or surprises in the notepads at `.sisyphus/notepads/search-retrieval-pg18-paradedb-execution/`.
