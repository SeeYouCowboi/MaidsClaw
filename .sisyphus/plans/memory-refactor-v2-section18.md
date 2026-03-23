# MaidsClaw Memory Refactor V2 - Section 18 Consensus Execution Plan

> Full plan with 21 detailed tasks drafted in planning session.
> This file is a structured summary. Full task details with references,
> acceptance criteria, and QA scenarios are in the planning conversation.

## Effort: XL | 3 Batches | 21 Tasks
## Critical Path: T1->T3->T5->T6->T7 -> T9->T11->T14 -> T17->T19->T20->T21

## Batch 1: Authority Write Path + Schema Split (T1-T8)
> Entry: V1 baseline complete | Exit: New tables only, old overlay stopped, persona immutable

- [ ] T1: Freeze V2 settlement 5-artifact boundary + localRef + relationIntents + conflictFactors contracts
- [ ] T2: Create private_episode_events schema + append-only repository (parallel with T1)
- [ ] T3: Create private_cognition_events append-only + private_cognition_current projection
- [ ] T4: Extract persona immutable; split pinned_summary / pinned_index (parallel with T2,T3)
- [ ] T5: Refactor settlement write chain: authoritative ledger + mandatory projection sync
- [ ] T6: Create area/world projection schema (area_state_current, area_narrative_current, world_*)
- [ ] T7: Cut old private write paths + compatibility layer read-only
- [ ] T8: Adapt sweeper / task-agent / organizer to new tables + secondary derived projection

## Batch 2: Frontstage Read Path Convergence (T9-T14)
> Entry: Batch 1 done | Exit: Typed Retrieval Surface, VisibilityPolicy sole, 4 prompt surfaces

- [ ] T9: Wire RetrievalOrchestrator into prompt main chain; build Typed Retrieval Surface
- [ ] T10: Enforce VisibilityPolicy as sole visibility judgment source (parallel with T9)
- [ ] T11: Converge prompt auto-injection to 4 primary surfaces
- [ ] T12: Reposition memory_explore as graph explain entry point (parallel with T11)
- [ ] T13: Introduce ToolExecutionContract + ArtifactContract runtime metadata (parallel with T11,T12)
- [ ] T14: Runtime / bootstrap / prompt integration verification and fixup

## Batch 3: Graph/Time/Explain Depth + Cleanup (T15-T21)
> Entry: Batch 2 done | Exit: Relation ontology, GraphEdgeView, dual time, acceptance tests, cleanup

- [ ] T15: Expand relation ontology with endpoint constraints (parallel with T16)
- [ ] T16: Build GraphEdgeView unified read abstraction (parallel with T15)
- [ ] T17: Deepen conflict structure: conflictFactors -> durable edges + conflict_summary
- [ ] T18: Build dual time-axis foundation (parallel with T17)
- [ ] T19: Implement area/world surfacing rules
- [ ] T20: Architecture acceptance tests: 5 scenario categories + legacy verification
- [ ] T21: Legacy cleanup and documentation update

## Critical Invariants
1. Persona outside memory, immutable; pinned_summary proposal-only; pinned_index system-maintained
2. Next-turn-visible content written synchronously; async flush never gates visibility
3. recent_cognition_slots session-scoped; durable cognition agent-scoped query-triggered
4. private_episode append-only experience; private_cognition append-only log + current projection
5. area_state/area_narrative and world_state/world_narrative separated; no auto area->world promotion
6. VisibilityPolicy = can see; RedactionPolicy / AuthorizationPolicy / retrieval policy independent
7. Settlement payload uses localRef + restricted intents; server owns durable ids/projections/edges

## Dependency Matrix
T1->T3,T5,T6 | T2->T5,T6 | T3->T5,T6,T7,T9 | T4->T6,T7,T8
T5->T6,T7,T9,T10 | T6->T7,T8,T9 | T7->T8,T20,T21 | T8->T20,T21
T9->T11,T14 | T10->T11,T14 | T11->T14 | T12->T14 | T13->T14
T14->T20,T21 | T15->T17,T20 | T16->T17,T20 | T17->T19,T20
T18->T20 | T19->T20 | T20->T21

## Anti-Patterns Banned
- Next-turn visibility depending on async flush/organizer/embeddings
- New writes to private_event/private_belief/old overlay tables
- private_episode carrying thought/emotion/projection_class/cognition_key
- Payload submitting arbitrary graph mutations/durable nodeRefs/open-ended relationIntents
- Single field for both read_scope and write_scope
- Single policy object for visibility+redaction+retrieval+authorization
- Narrative-only hints as sole retrieval surface
- memory_explore as generic retrieval bypass
- Latent area/world state directly injected into prompt
- Cleanup defined only by schema migration (must also clean prompt/tools/visibility/graph)

## Key References
- Consensus doc Section 18: docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md lines 1315-3369
- V1 baseline plan: .sisyphus/plans/memory-refactor.md (T1-T20 complete)
- Full task details with file references, acceptance criteria, and QA scenarios
  are in the planning conversation session that produced this plan.