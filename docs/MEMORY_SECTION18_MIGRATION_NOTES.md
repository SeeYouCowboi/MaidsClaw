# Section-18 Migration Notes

Date: 2026-03-23
Scope: T15 architecture acceptance + legacy private path retirement audit

## Goals

- Lock section-18 architecture acceptance into automated suites (runtime, memory, e2e).
- Verify legacy private naming (`private_event` / `private_belief`) is no longer used as canonical prompt/tool surface language.
- Verify failure-tier behavior stays split:
  - hard-fail for broken core references (`relationIntents/localRef`)
  - soft-fail degradation for shape-valid unresolved `conflictFactors[]`

## Acceptance Coverage Added

1. Synchronous settlement visibility
   - `test/runtime/memory-entry-consumption.test.ts`
   - Confirms cognition, episodes, publications, and recent slot are all visible in the same settlement transaction.

2. Cross-session durable recall
   - `test/runtime/private-thoughts-behavioral.test.ts`
   - Confirms same-agent cognition can be recalled from a different session.

3. Contested summary + explain drill-down
   - `test/memory/e2e-rp-memory-pipeline.test.ts`
   - `test/e2e/demo-scenario.test.ts`
   - Confirms contested current rows carry summary + refs and explain shell returns drill-down metadata.

4. Area/world surfacing boundary
   - `test/memory/e2e-rp-memory-pipeline.test.ts`
   - Confirms `area_visible` state does not auto-roll up to `world_public`.

5. Explain visibility/redaction
   - `test/e2e/demo-scenario.test.ts`
   - `test/memory/time-slice-query.test.ts`
   - Confirms hidden/private hops remain redacted placeholders through explain/time-slice output.

## Legacy Retirement Audit Results

- Prompt/tool canonical naming audit added in `test/e2e/demo-scenario.test.ts`.
- `src/memory/tools.ts` `focusRef` user-facing description was adjusted to avoid legacy private naming examples.
- Synchronous projection acceptance confirms section-18 write visibility without relying on delayed legacy sweeper paths.

## Failure-Tier Evidence

- Hard-fail: `prevalidateRelationIntents` rejects unsupported intent and invalid triggered target.
- Soft-fail: `resolveConflictFactors` resolves valid refs and drops unresolved refs without aborting.
- Assertion/evaluation runtime separation: dedicated rendering checks retained in behavioral runtime tests.
