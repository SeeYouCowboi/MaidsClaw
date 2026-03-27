# Operational Rollback Drill

## Purpose

This document describes manual rollback procedures for MaidsClaw's SQLite memory database. Use when a migration or maintenance operation corrupts data and you need to restore from backup.

## Prerequisites

- Access to the database file (path in `.env` as `MAIDSCLAW_DB_PATH`)
- A recent backup (see Backup section below)
- `bun` runtime available
- No running MaidsClaw processes accessing the database

## Step 1: Stop All Processes

1. Stop the MaidsClaw gateway (`Ctrl+C` or `kill` the process)
2. Verify no processes hold the database lock:
   - On Linux/macOS: `fuser <db-path>`
   - On Windows: check Task Manager for `bun` processes
3. Wait for any WAL checkpoint to flush (the `-wal` and `-shm` files should disappear or be empty)

## Step 2: Verify Current Database State

Run integrity check before attempting rollback:

```bash
bun run scripts/memory-maintenance.ts --integrity-check --report
```

Record the output — this captures the pre-rollback state for comparison.

## Step 3: Create Safety Copy

Before any destructive operation, copy the current (possibly corrupted) database:

```bash
cp <db-path> <db-path>.pre-rollback-$(date +%Y%m%d-%H%M%S)
cp <db-path>-wal <db-path>-wal.pre-rollback-$(date +%Y%m%d-%H%M%S) 2>/dev/null
cp <db-path>-shm <db-path>-shm.pre-rollback-$(date +%Y%m%d-%H%M%S) 2>/dev/null
```

## Step 4: Restore From Backup

Replace the database file with the backup:

```bash
cp <backup-path> <db-path>
rm -f <db-path>-wal <db-path>-shm
```

Removing the WAL/SHM files forces SQLite to start fresh journaling.

## Step 5: Run Migrations Forward

The backup may be from an older schema version. Run migrations to bring it current:

```bash
bun run scripts/memory-maintenance.ts --report
```

This runs `runMemoryMigrations()` on startup, then shows the table report so you can verify the schema is intact.

## Step 6: Post-Rollback Verification

1. Run integrity check:
   ```bash
   bun run scripts/memory-maintenance.ts --integrity-check --report
   ```

2. Run the verification script:
   ```bash
   bun run scripts/memory-verify.ts
   ```

3. Compare row counts against the pre-rollback report from Step 2 to understand what data was lost/restored.

## Step 7: Rebuild Derived Tables (if needed)

If the rollback lost derived/projection data but retained event ledgers:

```bash
bun run scripts/memory-rebuild-derived.ts
bun run scripts/search-rebuild.ts
```

These scripts rebuild projections from the canonical append-only event tables (`private_cognition_events`, `private_episode_events`, `area_state_events`, `world_state_events`).

## Step 8: Resume Operations

1. Start the MaidsClaw gateway
2. Monitor logs for the first few requests
3. Run `--report` again after some activity to confirm data is flowing

## Backup Strategy

### Recommended Schedule

- Before any manual migration: full copy
- Daily: automated copy via cron/scheduled task
- Before running `--vacuum`: full copy (VACUUM rewrites the entire file)

### Backup Command

```bash
sqlite3 <db-path> ".backup '<backup-path>'"
```

Using SQLite's `.backup` command is safer than `cp` on a live database because it handles WAL checkpointing.

## Canonical Ledger Tables (Never Delete)

These tables are append-only and form the source of truth:

| Table | Content |
|---|---|
| `private_cognition_events` | Agent belief/assertion changelog |
| `private_episode_events` | Agent episode history |
| `area_state_events` | Area state change ledger |
| `world_state_events` | World state change ledger |
| `settlement_processing_ledger` | Settlement processing audit trail |

All other tables (projections, search indexes, scores) can be rebuilt from these ledgers.

## Troubleshooting

### "database is locked" during restore
→ A process still holds the file. Kill all `bun` processes and retry.

### Integrity check fails after restore
→ The backup itself may be corrupted. Try an older backup.

### Migrations fail after restore
→ Check the `_migrations` table. If a migration ID is present but the table it created is missing, manually delete the migration row and re-run.

### WAL file is very large after restore
→ Run `PRAGMA wal_checkpoint(TRUNCATE)` or use `--vacuum` to compact.
