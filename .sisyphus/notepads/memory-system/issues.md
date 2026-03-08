# Memory System - Issues & Gotchas

## Known Issues

### I1: Reference directory missing
- Plan references `H:\MaidsClaw\reference\langmem\...` and `H:\MaidsClaw\reference\MemoryOS\...`
- These do NOT exist in the repo
- Impact: T8 (Task Agent) must implement LangMem-inspired extraction prompt from plan spec description only

## Gotchas

### G1: partial unique indexes in SQLite UPSERT
- `ON CONFLICT` clause in INSERT/UPDATE must reference the index columns + WHERE clause
- SQLite handles this with: `INSERT ... ON CONFLICT(col) WHERE condition DO UPDATE SET ...`
- Test carefully - partial index upserts are tricky in SQLite

### G2: FTS5 trigram tokenizer availability
- bun:sqlite bundles SQLite, but FTS5 + trigram support depends on SQLite compile flags
- Must test with: `CREATE VIRTUAL TABLE t USING fts5(content, tokenize='trigram')`
- If fails: document limitation, use 'unicode61' or 'ascii' tokenizer instead

### G3: TypeScript strict mode
- All files must compile with strict=true
- Use explicit types, no implicit any
- Branded string types (NodeRef) need careful implementation

### G4: same_episode edge sparsity
- Only adjacent events in sorted (session_id, topic_id, timestamp) sequence
- NOT a full clique - prevents O(N²) edge explosion
- Store as paired directed rows (both A→B and B→A)
