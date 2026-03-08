# Memory System - Decisions

## Architecture Decisions

### D1: TransactionBatcher Design
- bun:sqlite is synchronous → TransactionBatcher is synchronous too (no async/promise machinery)
- Pattern: queue ops, then wrap in BEGIN IMMEDIATE / COMMIT block
- No need for mutex or locking - single-threaded JS

### D2: FTS5 Trigram Verification
- MUST verify bun:sqlite supports FTS5 + trigram tokenizer before implementing
- Fallback: if not supported, document limitation and use simple tokenizer + app-level trigram logic

### D3: scope-aware entity upsert
- shared_public: INSERT OR IGNORE / ON CONFLICT(pointer_key) WHERE memory_scope='shared_public'
- private_overlay: ON CONFLICT(owner_agent_id, pointer_key) WHERE memory_scope='private_overlay'
- These are partial index conflicts - may need special UPSERT syntax

### D4: Materialization reconciliation
- Reconciliation is LINK-ONLY: private_event.event_id → existing public event
- NEVER update event_origin of existing row (stays 'runtime_projection')
- NEVER create duplicate area_visible event for same source_record_id

### D5: No reference directory
- Reference files (langmem, MemoryOS) don't exist at H:\MaidsClaw\reference
- Agents must implement from plan spec alone for extraction prompt patterns
