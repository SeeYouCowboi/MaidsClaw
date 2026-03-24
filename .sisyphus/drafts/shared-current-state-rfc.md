# RFC: Shared Current State Independent Domain Evaluation

**Task**: T37 — §11.1 Shared Current State 独立域
**Date**: 2026-03-24
**Status**: COMPLETE — Extend shared blocks (no new domain)

---

## 1. Problem Statement

There is no `group-scoped + mutable + current-state` structure in the current memory architecture. Existing structures handle either single-agent state or append-only group records, but not live mutable state that multiple agents can update and observe.

---

## 2. Candidate Scenarios

### Scenario A: Multi-Agent Task Division

Multiple agents are assigned to a shared task. Each agent holds a slice of the work. The group needs to see, at any moment, which agent is doing what, what's blocked, and what's complete — without issuing a full memory query each time.

**Requirements**: per-agent slot, mutable, group-readable, low latency.

### Scenario B: Group Alert Level

A squad of agents operating in the same area maintains a shared threat or readiness posture. Any agent can raise or lower the alert level. All agents should see the current value without polling all individual cognition states.

**Requirements**: shared single scalar value, write-any-read-all, timestamped for recency.

### Scenario C: Collaborative Workboard

A named set of agents collaborates on a structured task with multiple named slots (e.g., "research", "draft", "review"). Each slot has a current owner and status. The workboard represents live coordination state, not a historical log.

**Requirements**: named key-value slots, ownership per slot, group-scoped, fully mutable.

---

## 3. Boundary Comparison with Existing Structures

| Structure | Scope | Mutability | Content Model | Gap |
|---|---|---|---|---|
| Agent Projection | Single agent | Current-state | fact edges, scores | Single-agent only |
| Area Projection | Location-scoped | Current-state | area state (source_type: system/gm/inferred) | Not group-scoped, write path is system-only |
| Shared Blocks | Group-scoped | Append via patch-seq | Document sections (JSON) | No key-value current-state semantics |
| **Missing** | **Group-scoped** | **Mutable** | **Key-value state** | **None** |

The gap is clear: Shared Blocks are the closest match (group-scoped, multi-agent write via `SharedBlockPatchService`), but their content model is document-oriented. There's no lightweight key-value "current state" slot tied to a block.

---

## 4. Option Analysis

### Option A: New Independent Domain

Create a new `shared_current_state` table at the memory subsystem level, with its own repository, service, and auth model.

**Pros**: clean separation of concerns, bespoke API for key-value state, no coupling to shared blocks.

**Cons**: duplicates the auth model (member roles, retrieval_only flag, admin controls) already built in T24. Requires new migration, service layer, and test suite from scratch. Multiplies subsystem surface area without proportional benefit.

### Option B: Extend Shared Blocks with `current_state_entries`

Add a sub-table tied to `shared_blocks` that stores named key-value state entries per block. Each block can optionally carry live state alongside its document content.

**Pros**: reuses the existing auth model (T24's `SharedBlockPermissions`, `canMutateSharedBlocks`, `retrieval_only` controls), inherits patch conflict detection, no new permission model to design. Natural fit — a collaborative workboard *is* a shared block with live state slots.

**Cons**: slightly conflates document content and live state in one domain. Read patterns differ (block content = rich doc traversal; state entries = point lookups by key).

---

## 5. Recommendation: Extend Shared Blocks

**Do not create a new independent domain for V3.**

Reason: The T24 shared blocks implementation already built exactly the auth primitives needed (member roles, `canMutateSharedBlocks`, `retrievalOnly`, conflict-safe patch-seq). Duplicating that in a parallel domain would be wasteful and harder to maintain.

The correct approach is a `shared_block_state_entries` sub-table:

---

## 6. Schema Draft

```sql
CREATE TABLE shared_block_state_entries (
    id              TEXT    NOT NULL PRIMARY KEY,
    block_id        TEXT    NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE,
    key             TEXT    NOT NULL,
    value_json      TEXT    NOT NULL,
    updated_by_agent_id TEXT NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE(block_id, key)
);

CREATE INDEX idx_sbse_block ON shared_block_state_entries(block_id);
```

Write policy: any agent with `canMutateSharedBlocks` on the parent block can upsert any `(block_id, key)` pair. Retrieval-only blocks reject state writes. Reads are available to any block member.

---

## 7. Read/Write API Sketch

```typescript
// Write (upsert) a state entry — requires canMutateSharedBlocks
setBlockState(blockId: string, key: string, value: unknown, agentId: string): Promise<void>

// Read a single key — available to all members
getBlockState(blockId: string, key: string): Promise<StateEntry | null>

// Snapshot all current state for a block
getBlockStateSnapshot(blockId: string): Promise<Record<string, StateEntry>>
```

`StateEntry` carries `{ value, updatedByAgentId, updatedAt }` — enough for agents to see who last wrote and when.

---

## 8. Integration with Existing Memory Subsystem

- **Migration**: `memory:027` or later — adds `shared_block_state_entries` table.
- **Service**: `SharedBlockStateService` — thin wrapper over the new table, delegates auth checks to `SharedBlockPermissions`.
- **Retrieval**: `RetrievalService` can include state snapshots when building block-context for an agent's prompt, behind the existing `canReadSharedBlocks` gate.
- **No settlement payload changes**: state writes happen through direct service calls, not through the settlement pipeline.
