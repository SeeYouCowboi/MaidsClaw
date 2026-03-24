# RFC: Settlement Local Graph and Relation Intent Extension

**Task**: T32 — §23+§24 Settlement Graph + Relation Intent 扩展
**Date**: 2026-03-24
**Status**: COMPLETE — Minimal extension recommended; high-order edges remain server-side
**Depends on**: T26 output (see `settlement-payload-eval.md`)

---

## 1. Current State

### 1.1 Relation Type Inventory

`MEMORY_RELATION_TYPES` in `src/memory/types.ts` defines 9 relation types:

| Type | Layer | Direction | Invariant Class |
|---|---|---|---|
| `supports` | semantic | agent → fact | weak — additive evidence |
| `triggered` | causal | episode → cognition | weak — causal chain |
| `conflicts_with` | semantic | fact ↔ fact | symmetric — tension signal |
| `derived_from` | provenance | fact → source | weak — lineage trace |
| `supersedes` | temporal | new → old | **strong** — validity invalidation |
| `surfaced_as` | projection | raw → publication | **strong** — output record |
| `published_as` | distribution | content → channel | **strong** — audit trail |
| `resolved_by` | resolution | conflict → resolution | **strong** — graph closure |
| `downgraded_by` | temporal | fact → downgrade event | **strong** — state mutation |

"Strong" edges maintain graph invariants that can only be validated server-side (existence checks, temporal ordering, cross-table consistency). "Weak" edges express local intent that an agent can declare without needing global state access.

### 1.2 Current Payload Surface (from T26)

`RelationIntent` in `RpTurnOutcomeSubmissionV5` supports:

```typescript
{ sourceRef: localRef; targetRef: localRef; intent: "supports" | "triggered" }
```

This is already wired into the projection pipeline — the settlement layer reads `relationIntents` and materializes them as graph edges via the Symbolic Relation Layer (T13).

---

## 2. §23 — Richer Relation Intent Types

### 2.1 Analysis

§23 asks whether agents should be able to declare a wider vocabulary of relation intents at settlement time — for example, `conflicts_with`, `derived_from`, or `downgraded_by`.

**`conflicts_with`**: Symmetric edges are hard to validate unilaterally. An agent declaring `A conflicts_with B` cannot verify that `B` still exists, hasn't been superseded, or isn't already part of a resolved conflict chain. Server-side enforcement is needed.

**`derived_from`**: Provenance edges are safe in principle (they don't mutate target state), but they require the target node to be stable. If an agent submits `derived_from` a localRef that resolves to a fact that gets superseded in the same settlement, ordering becomes ambiguous. Safe to defer.

**`downgraded_by`**: This is a temporal mutation edge. An agent cannot safely emit this without knowing the current validity interval of the target. Server-side only.

### 2.2 Subgraph Templates

Templated subgraph patterns (e.g., "belief update" = supersedes + derived_from pair) would allow richer semantic modelling, but they imply bundled atomic writes across multiple edge types. This requires transactional enforcement that's not available at payload-declaration time.

**§23 verdict**: The current `supports` + `triggered` vocabulary is sufficient for V3. Richer types add constraint complexity with no V3 task requiring them.

---

## 3. §24 — Payload-Level Relation Intent (Delegation Boundary)

### 3.1 Forbidden from Payload Delegation

The following edge types **must remain server-side** and cannot be delegated to agent-submitted payloads:

| Edge | Reason |
|---|---|
| `surfaced_as` | Links a raw event to its published form. Requires knowing the output event ID, which is assigned during projection — not at agent declaration time. |
| `supersedes` | Invalidates a prior fact's `t_valid` window. Requires temporal lookups and ordering guarantees. An agent cannot safely emit this without current knowledge of the target's validity state. |
| `resolved_by` | Closes a conflict chain. Requires verifying the conflict exists, hasn't already been resolved, and the resolution is well-formed. Graph closure must be atomic and server-validated. |

Allowing any of these in agent payloads would create a split authority model where the server cannot fully trust the graph's consistency without re-validating every submitted edge.

### 3.2 Allowed for Future Payload

The following edge types are candidates for eventual payload-level delegation in V4+:

| Edge | Condition |
|---|---|
| `supports` | Already allowed. Safe — additive only, no mutation of existing nodes. |
| `triggered` | Already allowed. Safe — expresses causal annotation, no state mutation. |
| `conflicts_with` | Potentially allowable if scoped to localRef-only targets (intra-settlement conflicts), with server validation before materialization. |
| `derived_from` | Allowable if target exists and is stable. Could be added as an optional declared lineage. |

---

## 4. Validation Profiles

For any future expansion, the settlement pipeline should enforce a per-type validation profile:

- **Endpoint existence**: both source and target must resolve to materialized nodes before edge creation.
- **Temporal ordering**: for provenance/causal chains, `source.created_at` must be ≥ `target.created_at` (or the relationship is suspicious).
- **Idempotency**: `(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)` unique constraint already exists — this is sufficient.
- **Symmetry enforcement**: `conflicts_with` must be materialized as two directed edges if ever delegated, not a single undirected one.

---

## 5. Recommendation: Minimal

**For V3**: No extension to the current payload vocabulary. `supports` and `triggered` cover all V3 use cases (as established in T26).

**For V4**: Consider adding `conflicts_with` (intra-settlement scope only) and `derived_from` as optional declared intents, with a new validation profile layer in the settlement pipeline. Keep `surfaced_as`, `supersedes`, `resolved_by`, and `downgraded_by` server-side permanently.

The frozen boundary on `rp_turn_outcome_v5` should remain untouched for V3. Any extension is a V6 schema bump.

---

## Appendix: Edge Authority Matrix

| Edge Type | Agent Can Declare | Pipeline Enforced | Notes |
|---|---|---|---|
| `supports` | ✅ Now | endpoint check | Already in V5 |
| `triggered` | ✅ Now | endpoint check | Already in V5 |
| `conflicts_with` | V4 candidate | symmetry + existence | Scoped to localRef |
| `derived_from` | V4 candidate | temporal ordering | Target must be stable |
| `supersedes` | ❌ Never | — | Temporal graph invariant |
| `surfaced_as` | ❌ Never | — | Projection-assigned ID |
| `published_as` | ❌ Never | — | Distribution audit trail |
| `resolved_by` | ❌ Never | — | Graph closure must be atomic |
| `downgraded_by` | ❌ Never | — | Temporal mutation |
