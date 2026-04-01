# Task 1: Build & Test Baseline

**Date:** 2026-04-01  
**Purpose:** Establish pre-Memory-V3 baseline for comparison

## Build Status

| Metric | Value |
|--------|-------|
| Command | `bun run build` |
| Exit Code | 0 |
| Status | SUCCESS |
| Output | TypeScript type-check passed (`tsc -p tsconfig.build.json --noEmit`) |

## Test Status

| Metric | Value |
|--------|-------|
| Command | `bun test` |
| Bun Version | v1.3.10 (30e609e0) |
| Total Tests | 1238 |
| Files | 101 |
| **Passed** | **868** |
| **Skipped** | **349** |
| **Failed** | **21** |
| Expect Calls | 2190 |
| Duration | 2.93s |

## Pre-existing Failures (21 total)

### Database Connection Failures (8 tests)
These tests require PostgreSQL running on localhost:5432 (not available in this environment):

1. `createAppHost > local role creates host with user + admin, no maintenance`
2. `createAppHost > local role start/shutdown lifecycle`
3. `createAppHost > admin.getHostStatus returns HostStatusDTO shape`
4. `createAppHost > admin.getPipelineStatus returns PipelineStatusDTO shape`
5. `createAppHost > server role start/shutdown lifecycle with getBoundPort`
6. `createAppHost > server role without enableMaintenance has no maintenance facet`
7. `createAppHost > server role with enableMaintenance exposes maintenance facet`
8. `AppUserFacade acceptance contract > (unnamed)`

### Other Failures (13 tests)

9. `LocalSessionClient.closeSession flush decision matrix > returns not_applicable when closing via app host with no memory agent`
10. `config doctor > returns ready for minimal valid runtime-ready config`
11. `config doctor > returns explicit memory_pipeline_status for missing embedding model`
12. `debug commands > debug trace export rejects --unsafe-raw without local context`
13. `gateway mode > gateway evidence endpoints return structured JSON`
14. `gateway mode > session and turn commands run in gateway mode`
15. `Real TurnService-backed gateway path > real-path RP session emits status, full delta, then done`
16. `createAppHost role boundaries > server role (durable) starts gateway and consumer`
17. `createAppHost role boundaries > worker role starts consumer only and does not expose user facade`
18. `createAppHost role boundaries > shutdown is idempotent for all roles`
19. `createAppHost server durable mode > starts job consumer in addition to gateway when durable mode is enabled`
20. `createAppHost server durable mode > stops both gateway and consumer on shutdown when durable mode is enabled`
21. `createAppHost worker role > starts durable consumer on start and stops it on shutdown`

## Known Pre-existing Issues

- **LSP Type Errors:** `describe.skipIf` type errors in some pg-app test files are Bun type definition issues, not code failures
- **Environment Dependencies:** Many failures are due to missing PostgreSQL and external services

## Evidence Files

- Build output: `.sisyphus/evidence/task-1-build-baseline.txt`
- Test output: `.sisyphus/evidence/task-1-test-baseline.txt`
