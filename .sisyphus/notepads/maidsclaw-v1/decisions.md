# MaidsClaw V1 — Architectural Decisions

## [2026-03-08T11:49:07Z] Session: ses_332b867f2ffe5fO07tSXcVg0CU — Plan Start

### D1: Model Services Split
- ChatModelProvider + EmbeddingProvider + ModelServiceRegistry
- Anthropic = chat-only, OpenAI = chat + embedding
- Embedding: text-embedding-3-small (1536d)

### D2: Gateway V1 Contract
- 5 endpoints: POST /v1/sessions, POST /v1/sessions/{id}/turns:stream, POST /v1/sessions/{id}/close, GET /healthz, GET /readyz
- 7 SSE event types: status, delta, tool_call, tool_result, delegate, done, error
- Custom contract — NOT OpenAI-compatible

### D3: Knowledge Ownership (Two Planes)
- Narrative Plane: Lore Canon + Per-Agent Cognitive Graph + Public Narrative Store
- Operational Plane: Blackboard + Interaction Log + Job Runtime + Gateway
- Single-owner rule per canonical domain

### D4: Interaction Log
- InteractionRecord: 6 actorTypes, 7+ recordTypes
- Append-only, owned by T27a
- Memory module must NOT own interaction-log durability

### D5: Background Jobs
- 3 V1 Core job kinds: memory.migrate, memory.organize, task.run
- 5 execution classes (priority order)
- job_key dedup: coalesce/drop/noop

### D6: Verification
- Layer A: deterministic CI (mocked providers, fixture data)
- Layer B: live exploratory (real providers, soak tests)

### Memory Contract Lock
- event_origin: runtime_projection | delayed_materialization | promotion
- RuntimeProjection: synchronous, appendix-gated, speech-only for assistant messages
- Delayed Public Materialization: async, private_event → area_visible
- Promotion: area_visible → world_public (2-type pipeline)
- AreaStateResolver: retrieval-only, reads persisted event_origin

### Guardrails
- G1: Working Memory not durable across restarts
- G2: No world_id in V1 (single canon)
- G3: No entity merge execution in V1 Core
- G4: ContextCompactor must not evict before T28a ownership transfer

## [2026-03-09] F1 audit decision basis

- Treated `.sisyphus/plans/maidsclaw-v1.md` lines 636-699 as the compliance source of truth.
- Marked items PASS only when the repo contained direct file evidence; missing wiring or partial implementation was marked FAIL.
- Kept ownership checks module-based: interaction log -> `src/interaction/`, jobs -> `src/jobs/`, lore -> `src/lore/`, blackboard -> `src/state/`.

## [2026-03-09] F1 audit decision basis

- Used `.sisyphus/plans/maidsclaw-v1.md:636` through `.sisyphus/plans/maidsclaw-v1.md:699` as the compliance source of truth.
- Marked PASS only when the repository contained concrete code evidence; partial scaffolding or unwired hooks were marked FAIL.
- Counted summary totals against the audited report items written to `.sisyphus/evidence/final-F1-compliance.txt`.
