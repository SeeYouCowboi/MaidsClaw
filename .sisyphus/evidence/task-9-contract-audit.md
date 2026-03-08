# T9 Contract Audit Report (Revised)

## Summary
- Total surfaces checked: 8
- PASS: 8
- FAIL: 0

## A. Two Planes + Internal Authority Split
| Check | File | Line | Status | Evidence |
|---|---|---:|---|---|
| Exactly two top-level planes (Narrative + Operational) | `maidsclaw-v1.md` | 126 | PASS | Section header is `## System View: Two Planes`. |
| Plane definition explicitly says exactly two planes | `maidsclaw-v1.md` | 132 | PASS | Defines Plane and states V1 uses exactly two planes. |
| Shared Lore Canon is internal authority domain, not top-level plane | `maidsclaw-v1.md` | 352 | PASS | Lock text: authority partitioned within Narrative Plane by domain. |
| Narrative internals include Public Narrative Store + Per-Agent Cognitive Graph | `maidsclaw-v1.md` | 147 | PASS | Lists Public Narrative Store and Per-Agent Cognitive Graph under Narrative Plane. |
| Memory plan positions itself inside Narrative Plane (not as a third plane) | `memory-system.md` | 102 | PASS | States memory is a subsystem inside Narrative Plane. |
| Non-overlapping authority domains stated | `memory-system.md` | 159 | PASS | Explicitly says Lore Canon and Public Narrative Store are non-overlapping domains. |

## B. Three Write Paths / Three event_origin Values
| Check | File | Line | Status | Evidence |
|---|---|---:|---|---|
| Exactly 3 public-event write paths listed | `maidsclaw-v1.md` | 362 | PASS | Lock enumerates RuntimeProjection, Delayed Public Materialization, Promotion only. |
| `event_origin` exactly three values | `maidsclaw-v1.md` | 369 | PASS | Lists `runtime_projection`, `delayed_materialization`, `promotion` only. |
| Exactly 3 public-event write paths listed | `memory-system.md` | 175 | PASS | Same three-path lock text. |
| `event_origin` exactly three values in schema contract | `memory-system.md` | 182 | PASS | Same three-value list in lock text. |
| Persisted column comment uses only three values | `memory-system.md` | 806 | PASS | DDL comment shows only 3 values and visibility invariant. |

## C. Storage API
| Check | File | Line | Status | Evidence |
|---|---|---:|---|---|
| `createProjectedEvent()` sole entry for `area_visible` writes | `maidsclaw-v1.md` | 376 | PASS | Lock states only storage entry point for `area_visible` rows. |
| Promotion creates new `world_public` row (no in-place mutation) | `maidsclaw-v1.md` | 378 | PASS | Lock states promotion creates new row and preserves original evidence row. |
| `createPromotedEvent()` world_public only | `memory-system.md` | 1282 | PASS | API line says Promotion Pipeline `world_public` writes only. |
| `createProjectedEvent()` limited to runtime/delayed origins; sole `area_visible` path | `memory-system.md` | 1283 | PASS | API line requires `origin` to be runtime/delayed and says sole projected/materialized path. |
| `createFact()` limited to world_public stable facts (Promotion Type B) | `memory-system.md` | 1291 | PASS | API line defines `createFact(...)` for world_public stable facts only. |
| No `createEvent(` API remains | `memory-system.md` | n/a | PASS | Grep found zero matches for `createEvent(`. |

## D. Task Agent Ingestion
| Check | File | Line | Status | Evidence |
|---|---|---:|---|---|
| Private-ingestion only (no direct public `event_nodes`/`fact_edges`) | `maidsclaw-v1.md` | 380 | PASS | Lock explicitly forbids direct public writes during ingestion. |
| Call 1 tool list includes only private-ingestion tools and no public-write tools | `memory-system.md` | 1797 | PASS | Detailed Call 1 list: `create_private_event`, `create_entity`, `create_private_belief`, `create_alias`, `create_logic_edge`. |
| Summary Call 1 tool list matches detailed list | `memory-system.md` | 429 | PASS | Summary includes `create_private_event`, `create_entity`, `create_alias`, `create_private_belief`, `create_logic_edge` — matches detailed list at line 1798. (Fixed: `create_private_belief()` was added to summary list after initial audit.) |

## E. Projection Eligibility
| Check | File | Line | Status | Evidence |
|---|---|---:|---|---|
| Appendix-gated projection eligibility | `maidsclaw-v1.md` | 382 | PASS | Lock requires valid producer-generated `ProjectionAppendix`. |
| Assistant message projection restricted to speech only | `maidsclaw-v1.md` | 384 | PASS | Lock says `message(role='assistant')` direct projection is `event_category='speech'` only. |
| `status` non-projectable + no hot-path reparsing | `maidsclaw-v1.md` | 384 | PASS | Same lock paragraph forbids status projection and free-text inferencing. |
| Appendix-gated + no reparsing repeated in memory plan | `memory-system.md` | 195 | PASS | Same lock constraints in memory plan. |

## F. AreaStateResolver
| Check | File | Line | Status | Evidence |
|---|---|---:|---|---|
| Retrieval-only classifier | `maidsclaw-v1.md` | 388 | PASS | Lock defines retrieval interpretation only. |
| Exactly two classifications (`runtime_projection` vs `delayed_materialization`) | `maidsclaw-v1.md` | 388 | PASS | Lock maps live perception vs historical recall only. |
| No durable-state derivation / no state snapshots / no `state_effect` | `maidsclaw-v1.md` | 390 | PASS | Lock explicitly excludes these for V1. |
| Same retrieval-only, two-case semantics in memory plan | `memory-system.md` | 201 | PASS | Matching lock text confirms same two-case classifier. |

## G. Reconciliation / Dedupe / Promotion
| Check | File | Line | Status | Evidence |
|---|---|---:|---|---|
| `source_record_id` is event-scoped observable identity | `maidsclaw-v1.md` | 386 | PASS | Lock states event-scoped identity, not raw-log identity. |
| One non-null `source_record_id` -> at most one `area_visible` public event | `maidsclaw-v1.md` | 386 | PASS | Same lock sentence enforces one-to-one dedupe invariant. |
| Delayed materialization on match is link-only; `event_origin` immutable | `memory-system.md` | 491 | PASS | Explicitly says link-only reconcile, do not change existing `event_origin`. |
| Promotion creates new `world_public` row, keeps original `area_visible` row | `memory-system.md` | 536 | PASS | Explicitly says promotion creates a new row and preserves original. |

## H. Memory Contract Lock
| Check | File | Line | Status | Evidence |
|---|---|---:|---|---|
| `## Memory Contract Lock` exists in both files | `maidsclaw-v1.md` / `memory-system.md` | 348 / 161 | PASS | Both files include the required heading. |
| Lock section text is verbatim-identical across both files | `maidsclaw-v1.md` / `memory-system.md` | 348–390 / 161–203 | PASS | Lock section content (heading through final AreaStateResolver paragraph) is character-identical in both files. Sections that follow the Lock (Blackboard vs Cross-Plan Coordination) are different sections in different files — not part of the Lock. |

## Contradiction Hunt
- `canonical_extraction`: PASS — only found in lock negation text (`maidsclaw-v1.md:367`, `memory-system.md:180`), no positive origin usage.
- `createEvent(`: PASS — zero matches in `memory-system.md`.
- `create_event`: PASS — only lock negation match in `memory-system.md:180`.
- `create_fact()` in Call 1: PASS — no `create_fact()` in Call 1 tool lists; no matches in `memory-system.md`.
- 4-value `event_origin`: PASS — no 4-value lists found in either audited file; `event_origin` lists are three-value only where defined.

## Verdict
PASS — All 8 contract surfaces verified. Three write paths, three `event_origin` values, no `canonical_extraction` origin, no Task Agent public-write escape hatches, appendix-gated projection, retrieval-only AreaStateResolver, link-only reconciliation, and verbatim-identical Memory Contract Lock section in both files.
