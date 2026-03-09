# MaidsClaw

English | [简体中文](docs/README.zh-CN.md)

MaidsClaw is a TypeScript + Bun multi-agent engine built around a maid-household structure rather than a generic "one prompt, one bot" model.

In MaidsClaw, the maid theme is part of the runtime design:

- `Maiden` acts as the resident head maid who receives requests, coordinates work, and dispatches tasks.
- `RP Agent` represents a persistent maid persona with stable character, memory, and long-term continuity.
- `Task Agent` is a temporary maid-for-hire focused on a specific job, then dismissed when the work is done.

The goal is simple: make the maid identity show up not only in wording, but also in memory, etiquette, division of labor, scheduling, and context assembly.

---

## Project Flavor

If a generic agent framework is a toolbox, MaidsClaw is closer to a well-run mansion:

- the head maid keeps order instead of letting every character respond independently;
- each maid has her own persona, tone, boundaries, and memory;
- temporary work is delegated to task-focused agents instead of polluting long-lived roleplay context;
- lore, etiquette, shared state, and interaction history all participate in prompt construction.

This structure is especially suited for:

- maid-themed RP systems that need durable character continuity;
- hybrid systems that want both in-character interaction and practical task execution.

---

## Core Roles

### `Maiden`

`Maiden` is the persistent coordinator for the whole runtime.

She is responsible for:

- managing the lifecycle of other agents;
- dispatching tasks and coordinating work;
- maintaining global state;
- owning the main session and gateway entry points.

The "maid" feel starts here: not every agent has to rush forward and do everything itself.

### `RP Agent`

`RP Agent` is a persistent character maid built for long-term interaction.

Each one can carry:

- a stable persona;
- accumulated memory;
- scoped lore;
- anti-drift protections to keep the character from slipping out of role.

This is the layer for companionship, roleplay, and relationship continuity.

### `Task Agent`

`Task Agent` is an ephemeral worker created for a specific assignment.

Typical traits:

- task-oriented;
- short-lived;
- optionally structured output;
- removed after completion rather than kept as a long-term character.

That separation lets persistent maids stay in character while still allowing the system to get real work done.

---

## Runtime Model

All agents follow the same loop:

```text
Think -> Act -> Observe -> Repeat
```

- `Think`: assemble persona, lore, memory, interaction log, blackboard state, and other prompt context;
- `Act`: call the model, parse output, and execute tools when needed;
- `Observe`: write tool results and turn results back into context;
- `Repeat`: continue until the task ends or the agent is stopped.

The design bias is:

> dumb loop, smart model

The engine tries to stay structurally disciplined instead of hiding behavior inside too much framework magic.

---

## Why It Feels Like a Maid System

The maid identity comes from system layers, not just style prompts:

- `Persona`: defines identity, voice, behavior, and opening style.
- `Lore`: injects world rules, etiquette, and service boundaries into context.
- `Memory`: keeps long-term facts and prior interactions available to persistent characters.
- `Blackboard`: acts like a shared notice board for coordination between agents.
- `Interaction Log`: records what happened so context can be reconstructed consistently.
- `Tool System`: lets agents actually perform work through local or MCP-backed tools.

---

## Repository Status

This repository already contains substantial subsystem code, sample configs, storage, gateway pieces, tests, and native module support. The top-level runtime entry is still closer to scaffold / integration stage than a finished product runtime.

In practice, that means:

- the architecture is already clear;
- most major subsystems exist in the repository;
- the project is a solid base for iterating toward a full maid multi-agent runtime;
- the README should describe it accurately, not oversell it as fully productized today.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript (strict) |
| Native modules | Rust + NAPI-RS |
| Storage | SQLite via `bun:sqlite` |
| Model providers | OpenAI / Anthropic |
| Transport | HTTP + SSE |

Native modules are used for performance-sensitive paths such as:

- token counting;
- lore matching;
- context window management.

TypeScript fallbacks exist, so the system can still run without a compiled Rust build.

---

## Project Structure

```text
MaidsClaw/
├─ src/
│  ├─ agents/            Agent profiles, registry, lifecycle, maiden/RP/task agents
│  ├─ core/              Loop, prompt assembly, model access, tools, config, events
│  ├─ memory/            Core memory, retrieval, embeddings, materialization, promotion
│  ├─ persona/           Character cards and anti-drift constraints
│  ├─ lore/              World knowledge and lore matching
│  ├─ state/             Blackboard shared state
│  ├─ interaction/       Interaction log and context flushing
│  ├─ gateway/           HTTP / SSE gateway
│  ├─ storage/           SQLite, file storage, migrations
│  ├─ session/           Session services
│  └─ native-fallbacks/  TypeScript fallbacks for native modules
├─ native/               Rust NAPI-RS crate
├─ config/               Example provider, agent, persona, and lore configs
├─ scripts/              Demo and system-check scripts
├─ test/                 Tests
├─ docs/                 Localized and supplemental documentation
├─ .env.example
└─ package.json
```

---

## Quick Start

```bash
git clone <repo-url> MaidsClaw
cd MaidsClaw
bun install
```

Copy the example configuration files:

```bash
cp .env.example .env
cp config/providers.example.json config/providers.json
cp config/agents.example.json config/agents.json
cp config/personas.example.json config/personas.json
cp config/lore.example.json config/lore.json
```

Fill in the required values:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- your data directory and database path if needed

Start the project:

```bash
bun run start
```

To build native modules:

```bash
cd native
cargo build --release
cd ..
```

---

## Configuration

### `.env`

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `MAIDSCLAW_PORT` | Gateway port |
| `MAIDSCLAW_HOST` | Gateway bind host |
| `MAIDSCLAW_DB_PATH` | SQLite database path |
| `MAIDSCLAW_DATA_DIR` | Data directory |
| `MAIDSCLAW_NATIVE_MODULES` | Whether to attempt loading Rust native modules |

### Provider Tiers

MaidsClaw groups model providers into three tiers:

**Tier A (Stable)**: `anthropic`, `openai`
Official API keys via `.env`. These are the default providers and fully supported.

**Tier B (Compatible)**: `moonshot`, `minimax`
OpenAI-compatible providers. Set credentials in `config/auth.json` (preferred) or via env vars (`MOONSHOT_API_KEY`, `MINIMAX_API_KEY`). Not auto-selected by default; configure them explicitly via `config/providers.json`.

**Tier C (Experimental)**: `OpenAI ChatGPT Codex OAuth`, `Anthropic Claude Pro/Max OAuth`
Manual token import via `config/auth.json`. Enabled when credentials are present, but never auto-selected and never used as silent failover. Using these may violate provider terms of service.

### Provider Configuration

Optional provider overrides live in `config/providers.json`. Copy the example to get started:

```bash
cp config/providers.example.json config/providers.json
```

The example includes Moonshot/Kimi and MiniMax entries. You can also define custom OpenAI-compatible endpoints here.

### Auth Configuration

Non-env credentials go in `config/auth.json` (gitignored). Copy the example:

```bash
cp config/auth.example.json config/auth.json
```

Fill in your API keys or OAuth tokens for Tier B and Tier C providers.

### `config/agents.json`

Defines which agents are on duty and what role each one plays:

- `maiden`
- `rp_agent`
- `task_agent`

### `config/personas.json`

Defines who a maid is, how she speaks, how she serves, and what kind of opening behavior she uses.

### `config/lore.json`

Defines world rules, etiquette constraints, and background knowledge. A maid should know how the household works, not just how to reply.

## Adding a New Provider

Any OpenAI-compatible API can be added without writing a new transport class.

1. **Catalog entry** in `config/providers.json`: set `transportFamily` to `openai-compatible`, provide a `baseUrl`, and define your models.
2. **Auth config** in `config/auth.json`: add a credential entry with `"type": "api-key"` and your provider ID.
3. **Tests**: add a test that verifies the provider entry loads correctly and that auth resolves.

That's it. No new TypeScript source files needed for a standard API-key provider.

---

## Common Commands

```bash
# Type-check
bun run build

# Start the project
bun run start

# Run tests
bun test

# Run demo
bun run scripts/demo.ts

# Check service health
bun run scripts/check-system.ts

# Check Rust native module buildability
bun run check:native
```

---

## Example Character Direction

The sample persona already points toward the intended maid style:

- professional;
- polite;
- attentive to detail;
- proactively helpful without becoming overbearing;
- careful about privacy and discretion.

That is the distinction MaidsClaw is aiming for: not a chat window that says it is a maid, but a system structured to behave like one.

---

## Good Fit For

- maid-themed companion systems;
- roleplay applications with real task capability;
- multi-character mansion / butler-household simulations;
- interactive systems that need long-term memory, character constraints, and tool use together.

If what you want is a maid who can actually handle work, not just claim the title, this architecture is pointed in the right direction.

---

## License

TBD
