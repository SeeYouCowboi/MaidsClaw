# MaidsClaw Agent Runbook

> Read this before any real-model conversation test. It covers architecture, key files, runtime flow, and configuration — so you can skip codebase exploration entirely.

---

## What Is This Project

**MaidsClaw** is a TypeScript + Bun multi-agent engine. Not a chatbot wrapper — a structured runtime where distinct agents (Maiden, RP Agent, Task Agent) collaborate with memory, lore, and a shared blackboard. The "maid household" theme is architectural, not cosmetic.

**Three Roles:**

| Role | ID | Lifecycle | User-Facing | Output |
|------|----|-----------|-------------|--------|
| **Maiden** | `maid:main` | Persistent | Yes | Freeform |
| **RP Agent** | `rp:<personaId>` | Persistent | Yes | via `submit_rp_turn` tool |
| **Task Agent** | `task:default` | Ephemeral | No | Freeform |

---

## Directory Map

```
src/
├─ agents/           # Agent profiles, registry, presets, permissions
│  ├─ maiden/        # Maiden coordinator
│  ├─ rp/            # RP agent profile + tool policy
│  └─ task/          # Task agent config
├─ core/             # Agent loop, model providers, prompt assembly
│  ├─ agent-loop.ts  # Think→Act→Observe loop
│  ├─ models/        # ChatModelProvider, Anthropic/OpenAI/compat providers
│  ├─ prompt-builder.ts
│  └─ tools/         # Tool execution
├─ runtime/          # TurnService, RP turn contract (v5), viewer context
├─ memory/           # Core memory, embeddings, retrieval, cognition
├─ persona/          # CharacterCard loader + service
├─ lore/             # World rules, keyword injection
├─ state/            # Blackboard (in-memory coordination)
├─ interaction/      # Append-only conversation log
├─ session/          # Session lifecycle
├─ storage/          # PostgreSQL repos + schema
├─ bootstrap/        # bootstrapRuntime() — wires everything
├─ app/              # AppHost, facades, UserTurnService
│  ├─ host/          # AppHost type + factory
│  ├─ turn/          # UserTurnService
│  └─ clients/       # Local + gateway clients
├─ gateway/          # HTTP/SSE gateway (Bun.serve)
├─ jobs/             # Durable job execution (PgJobRunner)
└─ terminal-cli/     # CLI commands (chat, session, turn, debug, config)

config/              # Runtime config (agents, personas, lore, providers)
test/                # Unit + integration + acceptance tests
```

---

## Key Files to Know

| File | What it does |
|------|-------------|
| `src/core/agent-loop.ts` | Main execution loop — Think/Act/Observe/Repeat |
| `src/runtime/turn-service.ts` | Orchestrates a full user turn end-to-end |
| `src/app/host/create-app-host.ts` | Creates the AppHost (entry point for tests) |
| `src/app/turn/user-turn-service.ts` | Validates + dispatches user turns |
| `src/agents/presets.ts` | MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE |
| `src/agents/profile.ts` | `AgentProfile` type definition |
| `src/agents/registry.ts` | Central agent registry |
| `src/agents/rp/profile.ts` | `createRpProfile(personaId)` factory |
| `src/agents/rp/tool-policy.ts` | RP_AUTHORIZED_TOOLS list |
| `src/core/prompt-builder.ts` | Assembles system prompt from sections |
| `src/core/models/anthropic-provider.ts` | Anthropic model provider |
| `src/runtime/rp-turn-contract.ts` | RpTurnOutcomeSubmissionV5 schema |
| `src/memory/core-memory.ts` | CoreMemoryService |
| `src/interaction/store.ts` | InteractionStore (conversation log) |
| `src/storage/pg-app-schema-truth.ts` | Full DB schema |
| `src/bootstrap/runtime.ts` | `bootstrapRuntime()` — full init |

---

## Runtime Flow (User Turn)

```
User sends text
  └→ UserTurnService.executeUserTurn()
       └→ TurnService.runUserTurn()
            ├─ fetch session + history from InteractionStore
            ├─ assemble messages (user text appended)
            └→ AgentLoop.run(request)
                  ├─ [Think] PromptBuilder.build()  ← persona, lore, memory, blackboard
                  ├─ [Act]   ChatModelProvider.chatCompletion()  ← streaming
                  ├─ [Observe] parse tool_use blocks, execute tools
                  └─ repeat until stop_reason == "end_turn"
            ├─ settle RP turn outcome (cognition, episodes, publications)
            └─ CommitService → InteractionRecord written to DB
```

### RP Agent Special Case

RP agents **cannot reply directly**. They MUST call `submit_rp_turn` with:

```typescript
{
  publicReply: string,           // what the user sees
  latentScratchpad?: string,     // internal monologue (trace only)
  privateCognition?: {...},      // belief/evaluation/commitment deltas
  privateEpisodes?: [...],       // internal events (not user-visible)
  publications?: [...]           // world graph records
}
```

Direct text output from an RP agent is discarded.

---

## Prompt Sections (in assembly order)

| Slot | Content | Who |
|------|---------|-----|
| `PERSONA` | Character card (name, voice, system prompt) | RP agents |
| `LORE` | World rules, etiquette, keyword-triggered entries | All |
| `OPERATIONAL_STATE` | Blackboard state, session info | Maiden + RP |
| `MEMORY` | Core memory blocks + recent cognition | All persistent |
| `MESSAGE_HISTORY` | Conversation record | All |
| `CLOSING_INSTRUCTION` | submit_rp_turn framework | RP agents only |

---

## Model Providers

**Default models:**
- Maiden: `claude-3-5-sonnet-20241022`
- RP Agent: `claude-3-5-sonnet-20241022`
- Task Agent: `claude-3-5-haiku-20241022`

**Built-in providers:** Anthropic, OpenAI
**Optional (config/auth.json):** Moonshot/Kimi, MiniMax, Bailian, any OpenAI-compatible endpoint

Auth priority: `.env` keys → `config/auth.json`

---

## Configuration Files

| File | Purpose |
|------|---------|
| `.env` | API keys, port, data dir |
| `config/agents.json` | Active agent profiles |
| `config/personas.json` | Character cards (id, name, persona, system prompt) |
| `config/lore.json` | World rules (keywords, content, priority) |
| `config/providers.json` | Custom/override model providers |
| `config/auth.json` | Tier B/C provider credentials |
| `config/runtime.json` | Memory pipeline model IDs |

**Minimum for real-model tests:**
```
ANTHROPIC_API_KEY=sk-ant-...   # in .env
```

---

## Database

**Backend:** PostgreSQL

**Key tables:**
- `sessions` — session metadata (session_id, agent_id, closed_at)
- `interaction_records` — append-only conversation log (actor_type, record_type, payload)
- `core_memory_blocks` — character memory (Facts, Goals, Notes, Appearance)
- `cognition_events` — beliefs, evaluations, commitments
- `event_nodes` — story events (graph)
- `embeddings` — vector embeddings for semantic search

**Connection:** `PG_TEST_URL` env var, or main `DATABASE_URL`

**Pattern:** Repository layer in `src/storage/domain-repos/`, Unit of Work for transactions.

---

## Key Types

```typescript
// Agent identity
type AgentRole = "maiden" | "rp_agent" | "task_agent";
interface AgentProfile {
  id: string;               // e.g. "rp:alice"
  role: AgentRole;
  personaId?: string;       // e.g. "alice"
  modelId: string;
  toolPermissions: ToolPermission[];
  maxDelegationDepth: number;
  contextBudget?: { maxTokens: number };
}

// Execution context
interface RunContext {
  runId: string;
  sessionId: string;
  agentId: string;
  profile: AgentProfile;
  requestId: string;
  delegationDepth: number;
}

// Conversation record
type ActorType = "user" | "rp_agent" | "maiden" | "task_agent" | "system" | "autonomy";
type RecordType = "message" | "tool_call" | "tool_result" | "delegation" | "turn_settlement";
interface InteractionRecord {
  sessionId: string;
  recordId: string;
  recordIndex: number;
  actorType: ActorType;
  recordType: RecordType;
  payload: unknown;
  committedAt: number;
}

// RP turn output (v5)
interface RpTurnOutcomeSubmissionV5 {
  schemaVersion: "rp_turn_outcome_v5";
  publicReply: string;
  latentScratchpad?: string;
  privateCognition?: PrivateCognitionCommitV4;
  privateEpisodes?: PrivateEpisodeArtifact[];
  publications?: PublicationDeclaration[];
}

// Cognition ops (beliefs, feelings, goals)
type CognitionKind = "assertion" | "evaluation" | "commitment";
```

---

## RP Agent Tool Allowlist

RP agents are restricted to:
- `memory_read`
- `narrative_search`
- `cognition_search`
- `memory_explore`
- `persona_check_drift`
- `submit_rp_turn` ← **required to produce output**

Write memory tools (`core_memory_append`, `core_memory_replace`) are Maiden-only.

---

## Blackboard Namespaces

```
session.*          # session metadata
delegation.*       # delegation state
agent_runtime.*    # agent runtime state
task.*             # task state
memory.*           # memory pipeline state
```

---

## How to Start a Test Conversation

### Via AppHost (programmatic)

```typescript
import { createAppHost } from "./src/app/host/create-app-host";

const host = await createAppHost({ role: "local" });

// Create session
const session = await host.user.createSession({ agentId: "rp:alice" });

// Send turn (returns AsyncIterable<Chunk>)
for await (const chunk of host.user.executeUserTurn({
  sessionId: session.sessionId,
  text: "Hello Alice!"
})) {
  if (chunk.type === "text_delta") process.stdout.write(chunk.text);
}

await host.shutdown();
```

### Via CLI

```bash
# Interactive chat
bun run cli chat --agent rp:alice

# Single turn
bun run cli session create --agent rp:alice
bun run cli turn send --session <sessionId> --text "Hello"

# Debug a request
bun run cli debug summary --request <requestId>
```

### Via HTTP (server mode)

```bash
bun run start   # starts on port 3000

curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"agentId":"rp:alice"}'

curl -X POST http://localhost:3000/sessions/<id>/turns \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello!"}' -N   # SSE stream
```

---

## Running Tests

```bash
# All unit + integration tests (no real model)
bun test

# Real-model acceptance tests
bun test:acceptance:app-host

# PostgreSQL data-plane tests
PG_TEST_URL=postgres://user:pass@host/db bun test:pg:data-plane

# Full closeout suite (PG + memory + real model)
bun test:acceptance:closeout

# System health check
bun run scripts/check-system.ts
# or
bun run cli config doctor
```

---

## Guardrails (Don't Violate These)

1. **RP agents must use `submit_rp_turn`** — direct text is discarded
2. **Tool permissions are enforced per profile** — respect `toolPermissions` array
3. **Memory scope boundaries** — `shared_public` vs `private_overlay` are separate
4. **Sessions in `recovery_required`** reject new turns
5. **Delegation depth limit** — enforced via `maxDelegationDepth` in profile
6. **Blackboard namespace enforcement** — singleWriter policy per namespace
7. **Settlement idempotency** — `idempotencyKey` prevents duplicate processing
8. **Context budget** — truncation enforced, don't assume unlimited context

---

## Cognition Record Quick Reference (V4)

**Assertion** (belief):
```json
{ "kind": "assertion", "key": "alice/trust-bob",
  "proposition": { "subject": {"kind":"pointer_key","value":"alice"},
                   "predicate": "trusts",
                   "object": {"kind":"entity","ref":{"kind":"pointer_key","value":"bob"}} },
  "stance": "tentative",
  "basis": "inference" }
```

**Evaluation** (feeling/rating):
```json
{ "kind": "evaluation", "key": "alice/bob-likability",
  "target": {"kind":"pointer_key","value":"bob"},
  "dimensions": [{"name":"likability","value":0.8}],
  "emotionTags": ["warmth"] }
```

**Commitment** (goal/intent):
```json
{ "kind": "commitment", "key": "alice/goal-help-bob",
  "mode": "goal",
  "target": {"action":"help_bob_with_task"},
  "status": "active",
  "priority": 7,
  "horizon": "near" }
```
