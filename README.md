# MaidsClaw

A unified multi-agent engine for roleplay and task execution.

---

## Overview

MaidsClaw is a TypeScript + Bun engine that runs multiple LLM agents in parallel, each with its own identity, memory, and purpose. It handles two distinct modes in a single runtime: persistent character roleplay (RP agents) and ephemeral task workers (Task agents), coordinated by a central Maiden agent.

The core philosophy is **"dumb loop, smart model."** The engine itself is a simple repeating cycle. All interesting behavior comes from the LLM and how its agent profile is configured. MaidsClaw does not try to be clever about agent behavior; it gives each agent the right context and gets out of the way.

Native performance-critical operations (token counting, lore matching, context window management) are implemented as Rust NAPI-RS modules, with pure TypeScript fallbacks so the system works even without a compiled native build.

---

## Architecture

### The TAOR Loop

Every agent runs the same four-step cycle, repeated continuously:

```
Think  →  Act  →  Observe  →  Repeat
```

1. **Think** — The agent's context is assembled (persona, lore, memory, interaction log, blackboard state) and sent to the LLM as a streaming request.
2. **Act** — The model's output is parsed for tool calls or direct responses. Tool calls are dispatched through the `ToolExecutor`.
3. **Observe** — Results from tool calls (or the absence of any) are written back into the agent's context for the next iteration.
4. **Repeat** — The loop restarts. Agents do not exit unless explicitly stopped or they are ephemeral Task agents that have completed their work.

### Streaming Pipeline

All LLM calls return `AsyncIterable<Chunk>`. Chunks stream through the pipeline as they arrive and are flushed to the interaction log incrementally. The Gateway exposes this stream over HTTP + SSE to connected clients.

### AgentProfile System

Each agent is configured through an `AgentProfile` — a structured object that defines its model, system prompt, tool access, memory configuration, persona card, lore scope, and scheduling behavior. Profiles are loaded from JSON config files and can be composed from presets. The profile is the primary mechanism for controlling agent behavior; the loop itself has no hardcoded personality or logic.

---

## Key Concepts

### Agent Types

**Maiden** — The persistent coordinator. Manages the lifecycle of other agents, dispatches jobs, handles client sessions, and maintains global state. There is one Maiden per engine instance.

**RP Agent** — A persistent agent with a fixed character identity. Stays resident across sessions, accumulates memory over time, and maintains character consistency through the persona and anti-drift systems.

**Task Agent** — An ephemeral worker spun up for a specific job. Runs until the task is complete, then terminates. Task agents do not persist memory between invocations.

### Memory System

Memory is SQLite-backed with several distinct layers:

- **Core Memory** — Per-agent key-value store for facts that should always be in context (who the agent is, important relationships, standing instructions).
- **Episodic Storage** — Timestamped records of past interactions, retrieved by relevance and recency.
- **Embeddings** — Semantic vectors used during retrieval to surface the most relevant episodic memories.
- **Materialization** — The process of selecting which memories to include in the active context window, subject to token budget constraints.
- **Promotion** — Important episodic memories can be promoted into core memory, making them permanently available without retrieval.

### Persona and Lore

**Persona** — A character card loaded from config that defines an RP agent's identity, voice, and behavioral guidelines. The anti-drift subsystem detects when a model starts departing from the established persona and corrects course.

**Lore** — World knowledge entries scoped to an agent or shared globally. Lore matching (fast-pathed through the Rust native module) identifies which entries are relevant to the current context and injects them before the LLM call.

### Blackboard State

A namespaced shared state store accessible to all agents in an instance. Agents use the blackboard to coordinate without direct communication. State is organized by namespace and key, supports typed values, and is kept in memory with optional SQLite persistence.

### Interaction Log

A structured record of every message exchange in a session. The log is the source of truth for what was said and when. Agents read from it to reconstruct context; the commit service writes to it after each turn; the flush selector determines what portion of the log is included in the active context window.

### Tool System

Tools are registered locally through `ToolExecutor` or sourced from external processes via an MCP adapter. Agents declare which tools they have access to in their profile. Tool calls are parsed from model output, dispatched, and results returned as observations.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun >= 1.0.0 |
| Language | TypeScript (strict mode) |
| Native modules | Rust + NAPI-RS |
| Database | SQLite via `bun:sqlite` |
| LLM providers | Anthropic, OpenAI (configurable per agent) |
| Client transport | HTTP + SSE (built-in gateway) |

---

## Project Structure

```
MaidsClaw/
├── src/
│   ├── core/           # Agent loop, model clients, tool executor, prompt builder,
│   │                   # config loader, error types, event bus
│   ├── agents/         # AgentProfile, presets, registry, lifecycle manager
│   │   ├── maiden/     # Maiden coordinator logic
│   │   ├── rp/         # RP agent runtime and anti-drift
│   │   └── task/       # Task agent runner and result handling
│   ├── memory/         # Schema, storage, retrieval, embeddings, core-memory,
│   │                   # materialization, promotion
│   ├── persona/        # Character card loader, persona validation
│   ├── lore/           # Lore entries, matching, scope filtering
│   ├── state/          # Blackboard (namespaced shared state)
│   ├── interaction/    # Conversation log, commit service, flush selector
│   ├── jobs/           # Job queue, deduplication, dispatcher, scheduler
│   ├── gateway/        # HTTP server, SSE, routes, controllers
│   ├── session/        # Session management
│   ├── storage/        # SQLite database, file store, migrations
│   └── native-fallbacks/  # TypeScript fallbacks for Rust native modules
├── native/             # Rust NAPI-RS crate (token counter, lore matcher,
│                       # context window manager)
├── config/             # Example JSON configs (models, agents, personas, lore)
├── scripts/            # demo.ts, dev-server.ts, check-system.ts
├── test/               # 40 test files, 603 tests total
├── .env.example        # Environment variable template
└── package.json
```

---

## Prerequisites

- **Bun >= 1.0.0** — required. This project does not support Node.js.
- **Rust toolchain** — optional. Required only to build native modules. TypeScript fallbacks are used automatically if native modules are absent.
- Node.js type definitions are included as dev dependencies for type compatibility, but the runtime is Bun throughout.

---

## Getting Started

```bash
# Clone the repo
git clone <repo-url> MaidsClaw
cd MaidsClaw

# Install dependencies
bun install

# Set up environment
cp .env.example .env
# Edit .env and add your API keys and paths

# Copy and configure example configs
cp config/models.example.json config/models.json
cp config/agents.example.json config/agents.json
cp config/personas.example.json config/personas.json
cp config/lore.example.json config/lore.json

# (Optional) Build native Rust modules
cd native && cargo build --release && cd ..

# Start the engine
bun run start
```

---

## Configuration

### Environment Variables (`.env`)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude models) |
| `OPENAI_API_KEY` | OpenAI API key (for GPT models) |
| `MAIDSCLAW_PORT` | Gateway HTTP server port |
| `MAIDSCLAW_HOST` | Gateway bind host |
| `MAIDSCLAW_DB_PATH` | Path to the SQLite database file |
| `MAIDSCLAW_DATA_DIR` | Root directory for file storage and assets |
| `MAIDSCLAW_NATIVE_MODULES` | `true` or `false` — whether to attempt loading Rust native modules |

### Config Files (`config/`)

All config files are JSON. Start by copying the `.example.json` versions.

**`models.json`** — Named model configurations. Each entry maps a model alias to a provider, model ID, and default parameters (temperature, max tokens, etc.). Agent profiles reference models by alias.

**`agents.json`** — Agent profile definitions. Specifies which model each agent uses, its system prompt, tool access list, memory settings, and scheduling behavior.

**`personas.json`** — Character cards for RP agents. Defines name, background, voice, behavioral guidelines, and any persona-specific lore scope.

**`lore.json`** — World knowledge entries. Can be scoped globally or to specific agents/personas. Entries are matched against context at runtime.

---

## Scripts

```bash
# Type-check the project (no emit)
bun run build

# Run all tests
bun test

# Start the engine
bun run start

# Run the interactive demo
bun run scripts/demo.ts

# Check system health and native module status
bun run scripts/check-system.ts

# Check native Rust module compilation
bun run check:native
```

---

## Testing

The test suite covers 603 tests across 40 files, organized to mirror the `src/` structure.

```bash
# Run all tests
bun test

# Run tests for a specific module
bun test test/memory/

# Run a single test file
bun test test/core/prompt-builder.test.ts
```

Tests use Bun's built-in test runner (`bun:test`). Each major subsystem has its own test directory. Native module functionality is tested against both the Rust implementation and the TypeScript fallbacks to ensure behavioral parity.

---

## License

TBD
