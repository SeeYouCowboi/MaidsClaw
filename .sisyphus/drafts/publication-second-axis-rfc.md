# RFC: Publication Second Semantic Axis Evaluation

**Task**: T31 — §22 Publication 第二语义轴
**Date**: 2026-03-24
**Status**: COMPLETE — DEFER recommended

---

## 1. Current System

`PublicationDeclaration` carries a single `kind` field acting as the primary semantic axis:

| Kind | Meaning |
|---|---|
| `spoken` | Verbal utterance, dialogue, announcements |
| `written` | Text artifacts, notes, posted documents |
| `visual` | Non-verbal signals, gestures, displayed imagery |
| `broadcast` | Wide-area or system-level announcements |
| `record` | Structured records, log entries |

Target scope is handled by a separate `target` field (`current_area` | `world_public`), which already encodes one dimension of distribution.

---

## 2. Candidate Second Axis: `delivery_mode`

The proposal is to add a `delivery_mode` field capturing *how* content reaches recipients, independent of *what kind* of content it is.

Candidate values:

| Value | Meaning |
|---|---|
| `broadcast` | Pushed to all recipients in scope simultaneously |
| `rebroadcast` | Relay of a prior publication (attributed echo) |
| `system_notice` | Machine-generated, non-character-originated |
| `channel` | Routed through a named channel or medium |
| `audience_targeting` | Directed at a specific recipient subset |

---

## 3. Compatibility Analysis

Introducing `delivery_mode` alongside the existing type system creates several tensions:

**Overlap with `kind`**: `broadcast` already exists as a `kind` value. Promoting it to a `delivery_mode` value while keeping it as a `kind` variant would require a migration, a deprecation strategy, and disambiguation in the materialization pipeline.

**Payload shape**: `TurnSettlementPayload` → `PublicationDeclaration` is part of the frozen `rp_turn_outcome_v5` contract. Adding `delivery_mode` requires either a V6 schema bump or an optional additive field. Neither is trivial given the stability guarantees.

**Projection consumer impact**: `materializePublications` in the projection layer writes publication rows without consuming `kind` for routing logic. A second axis would need to be reflected in either the `publications` table schema (a migration) or projected into a new column, both of which cascade into query and view changes.

**Current coverage**: The `target` field (`current_area` | `world_public`) already captures the most common distribution distinction. Most V3 scenarios can be expressed as `kind + target` without needing a delivery modality.

---

## 4. Scenarios That Would Benefit

- An agent relaying information from a third party (`rebroadcast`) where attribution is important.
- System-generated status updates clearly marked `system_notice` to distinguish from character dialogue.
- Channel-routed messages where the medium (e.g., "notice board", "radio frequency") is semantically relevant to the scene.

These are real edge cases but not required by any V3 task.

---

## 5. Recommendation: DEFER

**Do not introduce `delivery_mode` in V3.**

Rationale:

1. No task in T25-T38 is blocked by its absence. T25 is about pipeline reliability, T32 is about graph edges — neither touches publication semantics.
2. The `broadcast` naming collision between `kind` and the candidate axis requires careful design work that belongs in its own V4 design pass.
3. The frozen `rp_turn_outcome_v5` boundary should not absorb an optional field without a concrete consumer in the same release.
4. Current `kind + target` already distinguishes the meaningful cases for V3 scenes.

If future scenarios (rebroadcast attribution, system notice separation, channel routing) gain traction, revisit this as a V4 payload extension after T31 context has been absorbed into the schema versioning plan.

---

## Appendix: Extension Point

When this is revisited, the cleanest approach is:

```typescript
// V6 additive extension (optional field, defaults to "direct")
delivery_mode?: "direct" | "broadcast" | "rebroadcast" | "system_notice" | "channel";
```

Combined with retiring `broadcast` from `kind` in the same V6 bump, using a `COMPAT_ALIAS_MAP` pattern (already established for core memory labels) to handle legacy records.
