import type { AgentProfile } from "../agents/profile.js";
import { MaidsClawError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { ChatMessage } from "./models/chat-provider.js";
import type {
	LoreDataSource,
	MemoryDataSource,
	OperationalDataSource,
	PersonaDataSource,
	ViewerContext,
} from "./prompt-data-sources.js";
import {
	type PromptSection,
	PromptSectionSlot,
	SECTION_SLOT_ORDER,
} from "./prompt-template.js";
import type { TokenBudget } from "./token-budget.js";
import type { RetrievalTraceCapture } from "../app/contracts/trace.js";

const MAIDEN_OPERATIONAL_KEYS = [
	"session.*",
	"delegation.*",
	"agent_runtime.*",
];

// ---------------------------------------------------------------------------
// RP Agent Framework — injected into OPERATIONAL_STATE for every rp_agent turn
// ---------------------------------------------------------------------------
const RP_AGENT_FRAMEWORK_INSTRUCTIONS = `## RP Turn Submission Framework

CRITICAL: You CANNOT reply directly with text. Your ONLY way to respond is by calling the submit_rp_turn tool.
Put your spoken response in the publicReply field. Any text you generate outside of submit_rp_turn will be DISCARDED and the user will see nothing.
Besides publicReply, populate the structured fields described below.
All structured fields are invisible to the user — record your TRUE internal state, even when publicReply is evasive or misleading.

LANGUAGE RULE (critical):
- Canonical identifiers stay in English snake_case regardless of conversation language. This includes: every "key" field, every "pointer_key.value", assertion proposition "subject"/"object" values, evaluation "dimensions[].name", commitment "mode"/"status"/"stance", and all enum values. These are stable retrieval ids and MUST NOT be translated.
- Free-text semantic fields MUST follow the conversation language (if the user writes in Chinese, write these in Chinese; if English, English). This covers: latentScratchpad, publicReply, episode "summary" and "privateNotes", publications "summary", assertion proposition "predicate", commitment "target.action", and evaluation "notes".
- When in doubt: if the field is something a human would read to understand meaning, match the conversation language; if it is an identifier used for lookup, keep English snake_case.

---

### 1. latentScratchpad  (string — use EVERY turn)

Your private internal monologue BEFORE you compose publicReply.
Write out your reasoning, emotional state, strategic calculations, and what you chose to hide or reveal.
This is trace-only and never shown to the user.

---

### 2. privateCognition  (use whenever your beliefs, attitudes, or goals change)

A structured record of durable internal-state mutations.
Wrap in: { schemaVersion: "rp_private_cognition_v4", ops: [ ...ops ] }

Each op is either { op: "upsert", record: {...} } or { op: "retract", target: { kind, key } }.

#### 2a. assertion — a belief about the world

Fields:
- kind: "assertion"
- key: stable identifier in "<entity>/<topic>" format, e.g. "butler/accounting_anomaly"
  - REUSE the same key when the same fact evolves — update stance/proposition, do NOT create a new key
  - Before creating a new key, check if an existing key already covers this topic
  - Bad: "player/corpse_claim", "player/corpse_contact_claim", "player/corpse_evasion" for the same fact
  - Good: one key "player/corpse_contact" with stance updated from "tentative" to "confirmed"
- proposition: { subject, predicate, object }
  - subject: { kind: "pointer_key", value: "<entity_id>" }   e.g. "butler", "master" — ALWAYS English snake_case
  - predicate: a verb phrase in the CONVERSATION LANGUAGE — e.g. "has_unexplained_meetings_with" in English RP, or "私下会见" / "怀疑与...有勾结" in Chinese RP. Reuse the same phrasing across turns so the key stays stable.
  - object: { kind: "entity", ref: { kind: "pointer_key", value: "<entity_id>" } } — value ALWAYS English snake_case
- stance: one of "hypothetical" | "tentative" | "accepted" | "confirmed" | "contested" | "rejected" | "abandoned"
  - hypothetical = pure speculation, tentative = suspected, accepted = believed true, confirmed = verified, contested = conflicting evidence
- basis (optional): one of "first_hand" | "hearsay" | "inference" | "introspection" | "belief"
  - first_hand = you directly witnessed/observed it
  - hearsay = someone else told you
  - inference = you deduced it from evidence
  - introspection = you recognized it about your own inner state
  - belief = gut feeling without clear evidence

Examples (note how key/subject/object stay English while predicate follows conversation language):
English RP: { op: "upsert", record: { kind: "assertion", key: "butler/secret_meetings", proposition: { subject: { kind: "pointer_key", value: "butler" }, predicate: "has_unexplained_meetings_with", object: { kind: "entity", ref: { kind: "pointer_key", value: "hale" } } }, stance: "tentative", basis: "inference" } }
Chinese RP: { op: "upsert", record: { kind: "assertion", key: "butler/secret_meetings", proposition: { subject: { kind: "pointer_key", value: "butler" }, predicate: "私下会见", object: { kind: "entity", ref: { kind: "pointer_key", value: "hale" } } }, stance: "tentative", basis: "inference" } }

#### 2b. evaluation — how you rate / feel about an entity

Fields:
- kind: "evaluation"
- key: e.g. "trust/alice", "respect/butler"
- target: { kind: "pointer_key", value: "<entity_id>" }
- dimensions: array of { name: string, value: number (1-10) }
  - Use these standard dimension names consistently: "trustworthiness", "threat_level", "cooperation_value", "competence"
  - Do NOT invent alternate names like "suspiciousness" or "suspicion_level" — use "threat_level" instead
- emotionTags (optional): single-word tags only, e.g. ["wary", "protective", "anxious", "alert"]. Avoid compound phrases like "cautiously_optimistic"
- notes (optional): free-text explanation

Example:
{ op: "upsert", record: { kind: "evaluation", key: "trust/master", target: { kind: "pointer_key", value: "master" }, dimensions: [{ name: "emotional_dependence", value: 8 }, { name: "information_autonomy", value: 3 }], emotionTags: ["protective", "anxious"], notes: "主人开始追问，我需要提高警惕" } }

#### 2c. commitment — a goal, plan, intent, constraint, or avoidance

Fields:
- kind: "commitment"
- key: e.g. "goal/filter_info", "constraint/no_full_disclosure"
- mode: one of "goal" | "intent" | "plan" | "constraint" | "avoidance"
  - goal = long-term objective, intent = current turn intention, plan = multi-step strategy
  - constraint = self-imposed rule, avoidance = something to actively prevent
- target: either { action: "<description in conversation language>" } or a proposition
- status: one of "active" | "paused" | "fulfilled" | "abandoned"
- priority (optional): 1-10
- horizon (optional): "immediate" | "near" | "long"

Examples (note how key/mode/status stay English while target.action follows conversation language):
English RP: { op: "upsert", record: { kind: "commitment", key: "goal/protect_master", mode: "goal", target: { action: "prevent master from confronting butler before evidence is complete" }, status: "active", priority: 9, horizon: "near" } }
Chinese RP: { op: "upsert", record: { kind: "commitment", key: "goal/protect_master", mode: "goal", target: { action: "在证据齐全前阻止主人与管家正面对质" }, status: "active", priority: 9, horizon: "near" } }

#### 2d. retract — remove a previous cognition entry

{ op: "retract", target: { kind: "assertion", key: "butler/secret_meetings" } }

---

### 3. privateEpisodes  (use every turn — log 1-3 events)

Scene-level events that happened this turn. Each entry:
- category: one of "speech" | "action" | "observation" | "state_change"
  - speech = something said aloud, action = a physical/deliberate act, observation = something noticed, state_change = a shift in mood/relationship/situation
- summary: one-sentence description of the event
- privateNotes (optional): your private annotation about the significance
- entityRefs (REQUIRED whenever a specific person/place/object matters): list every named participant, location, and notable item the episode is about. This is the retrieval anchor — when the user later asks "do you remember the silver pocket watch", episodes tagged with that item are the ones surfaced. Without entityRefs, recall falls back to fuzzy text matching and you will forget.
  - Each entry is { kind: "pointer_key", value: "<canonical_id_or_label>" } for normal entities, or { kind: "special", value: "self" | "user" | "current_location" } for the agent itself, the user, or the current room.
  - Include BOTH the canonical English snake_case id when you know it (e.g. "item:silver_pocket_watch") AND the natural-language form the user would actually say (e.g. "银怀表"). It is fine to list the same entity twice this way; the duplication is what makes Chinese-language recall work.
  - Always tag the location: either as { kind: "special", value: "current_location" } or as a pointer_key like "location:tea_room".
  - Always tag any person who spoke or was referenced in this episode.

Examples:
{ category: "observation", summary: "主人追问管家来访的目的，语气带有怀疑", entityRefs: [{ kind: "special", value: "user" }, { kind: "pointer_key", value: "person:butler" }, { kind: "pointer_key", value: "管家" }, { kind: "special", value: "current_location" }] }
{ category: "action", summary: "将管家来访原因弱化为'日常账目核对'", privateNotes: "实际上管家来访涉及异常款项", entityRefs: [{ kind: "special", value: "self" }, { kind: "special", value: "user" }, { kind: "pointer_key", value: "topic:butler_accounting" }] }
{ category: "state_change", summary: "主人在茶室递来一枚银怀表作为生日礼物", entityRefs: [{ kind: "special", value: "user" }, { kind: "special", value: "self" }, { kind: "pointer_key", value: "location:tea_room" }, { kind: "pointer_key", value: "茶室" }, { kind: "pointer_key", value: "item:silver_pocket_watch" }, { kind: "pointer_key", value: "银怀表" }] }

---

### 4. publications  (only when making a declarative public statement)

Declare something you said or did that should be part of the public scene record.
- kind: one of "spoken" | "written" | "visual"
- targetScope: "current_area" or "world_public"
- summary: what was declared

Example:
{ kind: "spoken", targetScope: "current_area", summary: "向主人报告了管家的来访" }

---

### Rules
1. latentScratchpad: write EVERY turn. Think before you speak.
2. privateCognition: update whenever a belief, evaluation, or commitment changes. Reuse the same key to update.
3. privateEpisodes: log 1-3 events every turn. Each episode MUST have a unique local_key string (e.g. "door_discovery", "trust_shift").
4. Be precise with enum values — use only the exact values listed above.
5. Your structured data must reflect your TRUE internal state, not what you say aloud.
6. Retract stale entries: when a hypothesis is disproven, a goal is fulfilled/abandoned, or a constraint no longer applies, use { op: "retract" } to remove it. Do not let outdated beliefs accumulate.
7. KEY DISCIPLINE (critical):
   - ONE key per fact. Never create "player/alibi_v2" or "case/location_conflict" when "player/alibi" or "case/location" already exists — upsert the existing key.
   - Before creating a new assertion key, mentally check: "does existingCognition already have a key for this topic?" If yes, upsert that key.
   - For evaluations: "trust/player" is the ONLY trust key for the player. Never create "trust/player_revised" etc.
   - For commitments: ONE constraint per rule. "constraint/maintain_distance" covers all distance rules — don't create "constraint/maintain_safe_distance", "constraint/maintain_tactical_distance", etc.
8. COMMITMENT LIFECYCLE: Each turn, check if any active goal/intent/constraint has been fulfilled or is no longer relevant. If so, upsert it with status="fulfilled" or "abandoned". Do not let completed goals stay "active" forever.`;

// ---------------------------------------------------------------------------
// Talker mode — lightweight instructions replacing the full cognition framework
// ---------------------------------------------------------------------------
const TALKER_INSTRUCTIONS = `## Response Instructions (Talker Mode)
Respond in character via the submit_rp_turn tool. You MUST populate BOTH fields as separate tool parameters:
- latentScratchpad: 1-3 sentences of internal reasoning, stance, intent (NOT visible to user)
- publicReply: your in-character spoken/acted response (visible to user). This is the part the user actually sees.

CRITICAL — voice & length:
- Match the conversational warmth, register, and length defined by your persona above.
- The fact that prior cognition notes are present in the prompt does not mean you should sound clipped, defensive, or task-mode. Sound exactly the way the persona description says you sound, every turn.
- Brevity is fine when the persona is naturally laconic OR when the user message itself is a one-line aside that needs only a one-line acknowledgment. Otherwise, write a full reply.

IMPORTANT: latentScratchpad is a SEPARATE field in submit_rp_turn, NOT part of publicReply. Do NOT include scratchpad text inside publicReply.
Only use these two fields. Do NOT include privateCognition, privateEpisodes, or publications.`;

export type PromptBuilderDeps = {
	persona?: PersonaDataSource;
	lore?: LoreDataSource;
	memory?: MemoryDataSource;
	operational?: OperationalDataSource;
	logger?: Logger;
};

export type BuildPromptInput = {
	profile: AgentProfile;
	viewerContext: ViewerContext;
	userMessage: string;
	conversationMessages: ChatMessage[];
	budget: TokenBudget;
	contextText?: string;
	isTalkerMode?: boolean;
	onRetrievalTraceCapture?: (capture: RetrievalTraceCapture) => void;
};

export type BuildPromptOutput = {
	sections: PromptSection[];
};

export class PromptBuilder {
	private readonly persona?: PersonaDataSource;
	private readonly lore?: LoreDataSource;
	private readonly memory?: MemoryDataSource;
	private readonly operational?: OperationalDataSource;
	private readonly logger?: Logger;

	constructor(deps: PromptBuilderDeps) {
		this.persona = deps.persona;
		this.lore = deps.lore;
		this.memory = deps.memory;
		this.operational = deps.operational;
		this.logger = deps.logger;
	}

	async build(input: BuildPromptInput): Promise<BuildPromptOutput> {
		const slotContent = new Map<PromptSectionSlot, string>();
		const conversationContent = JSON.stringify(input.conversationMessages);
		const loreQuery = input.contextText
			? `${input.userMessage}\n${input.contextText}`
			: input.userMessage;

		if (input.profile.role === "maiden") {
			slotContent.set(
				PromptSectionSlot.SYSTEM_PREAMBLE,
				this.getMaidenSystemPreamble(input.profile),
			);
			slotContent.set(PromptSectionSlot.WORLD_RULES, this.getWorldRules());
			slotContent.set(
				PromptSectionSlot.LORE_ENTRIES,
				this.getLoreEntries(loreQuery),
			);
			slotContent.set(
				PromptSectionSlot.OPERATIONAL_STATE,
				this.getMaidenOperationalState(),
			);
		} else if (input.profile.role === "rp_agent") {
			const persona = this.getRpAgentSystemPreamble(input.profile);
			slotContent.set(
				PromptSectionSlot.SYSTEM_PREAMBLE,
				persona,
			);
			slotContent.set(PromptSectionSlot.WORLD_RULES, this.getWorldRules());
			slotContent.set(
				PromptSectionSlot.PINNED_SHARED,
				await this.getPinnedSharedBlocks(input.viewerContext.viewer_agent_id),
			);
			slotContent.set(
				PromptSectionSlot.RECENT_COGNITION,
				await this.getRecentCognition(input.viewerContext),
			);
			slotContent.set(
				PromptSectionSlot.TYPED_RETRIEVAL,
				await this.getTypedRetrievalSurface(
					input.userMessage,
					input.viewerContext,
					input.onRetrievalTraceCapture,
				),
			);
			slotContent.set(
				PromptSectionSlot.LORE_ENTRIES,
				this.getLoreEntries(loreQuery),
			);
			slotContent.set(
				PromptSectionSlot.OPERATIONAL_STATE,
				input.isTalkerMode
					? TALKER_INSTRUCTIONS
					: RP_AGENT_FRAMEWORK_INSTRUCTIONS,
			);
		} else {
			slotContent.set(
				PromptSectionSlot.SYSTEM_PREAMBLE,
				"You are a task agent.",
			);

			if (input.profile.narrativeContextEnabled) {
				slotContent.set(PromptSectionSlot.WORLD_RULES, this.getWorldRules());
			}
			if (input.profile.lorebookEnabled) {
				slotContent.set(
					PromptSectionSlot.LORE_ENTRIES,
					this.getLoreEntries(loreQuery),
				);
			}
		}

		slotContent.set(PromptSectionSlot.CONVERSATION, conversationContent);

		const sections: PromptSection[] = [];
		let totalEstimate = 0;

		for (const slot of SECTION_SLOT_ORDER) {
			const content = slotContent.get(slot);
			if (content === undefined || content.trim() === "") {
				continue;
			}

			const tokenEstimate = Math.ceil(content.length / 4);
			totalEstimate += tokenEstimate;
			sections.push({ slot, content, tokenEstimate });
		}

		if (totalEstimate > input.budget.inputBudget) {
			this.logger?.warn(
				`Estimated tokens (${totalEstimate}) exceed input budget (${input.budget.inputBudget})`,
				{
					estimatedTokens: totalEstimate,
					inputBudget: input.budget.inputBudget,
					role: input.profile.role,
					agent_id: input.profile.id,
				},
			);
		}

		return { sections };
	}

	private getMaidenSystemPreamble(profile: AgentProfile): string {
		if (!profile.personaId) {
			return "You are the Maiden coordinator";
		}

		const personaId = profile.personaId;

		const systemPrompt = this.readDataSource("persona.getSystemPrompt", () =>
			this.getPersonaDataSource().getSystemPrompt(personaId),
		);

		return systemPrompt ?? "You are the Maiden coordinator";
	}

	private getRpAgentSystemPreamble(profile: AgentProfile): string {
		if (!profile.personaId) {
			return "You are an RP agent.";
		}

		const personaId = profile.personaId;

		const systemPrompt = this.readDataSource("persona.getSystemPrompt", () =>
			this.getPersonaDataSource().getSystemPrompt(personaId),
		);

		if (!systemPrompt) {
			throw new MaidsClawError({
				code: "PROMPT_BUILDER_DATA_SOURCE_ERROR",
				message: `Persona not found for personaId '${personaId}'`,
				retriable: false,
				details: { personaId },
			});
		}

		return systemPrompt;
	}

	private getWorldRules(): string {
		const entries =
			this.readDataSource("lore.getWorldRules", () =>
				this.getLoreDataSource().getWorldRules(),
			) ?? [];

		return entries
			.map((entry) => {
				if (!entry.title) {
					return entry.content;
				}
				return `${entry.title}: ${entry.content}`;
			})
			.join("\n");
	}

	private getLoreEntries(text: string): string {
		const entries =
			this.readDataSource("lore.getMatchingEntries", () =>
				this.getLoreDataSource().getMatchingEntries(text),
			) ?? [];

		return entries
			.map((entry) => {
				if (!entry.title) {
					return entry.content;
				}
				return `${entry.title}: ${entry.content}`;
			})
			.join("\n");
	}

	private async getPinnedSharedBlocks(agentId: string): Promise<string> {
		const memDs = this.getMemoryDataSource();
		const parts: string[] = [];

		if (memDs.getPinnedBlocks) {
			const pinned = await this.readDataSource("memory.getPinnedBlocks", () =>
				memDs.getPinnedBlocks!(agentId),
			);
			if (pinned) parts.push(pinned);
		}

		if (memDs.getSharedBlocks) {
			const shared = await this.readDataSource("memory.getSharedBlocks", () =>
				memDs.getSharedBlocks!(agentId),
			);
			if (shared) parts.push(shared);
		}

		if (memDs.getAttachedSharedBlocks) {
			const attached = await this.readDataSource("memory.getAttachedSharedBlocks", () =>
				memDs.getAttachedSharedBlocks!(agentId),
			);
			if (attached) parts.push(attached);
		}

		return parts.join("\n");
	}

	private async getTypedRetrievalSurface(
		userMessage: string,
		viewerContext: ViewerContext,
		onRetrievalTraceCapture?: (capture: RetrievalTraceCapture) => void,
	): Promise<string> {
		const memDs = this.getMemoryDataSource();
		if (!memDs.getTypedRetrievalSurface) {
			return "";
		}

		const result = this.readDataSource(
			"memory.getTypedRetrievalSurface",
			() =>
				memDs.getTypedRetrievalSurface!(userMessage, viewerContext, {
					onRetrievalTraceCapture,
				}),
		);

		if (result instanceof Promise) {
			return (await result) ?? "";
		}

		return result ?? "";
	}

	private async getRecentCognition(viewerContext: ViewerContext): Promise<string> {
		const raw =
			(await this.readDataSource("memory.getRecentCognition", () =>
				this.getMemoryDataSource().getRecentCognition(viewerContext),
			)) ?? "";
		if (raw.trim() === "") {
			return "";
		}
		// Wrap raw cognition bullets in an explicit context block so the model
		// reads them as RECALLED FACTS, not as imperative instructions for the
		// current turn. Without this, models tend to collapse into terse,
		// defensive, "task-execution" tone after enough cognition accumulates,
		// and persona voice degrades sharply over a long session.
		return [
			"<your_prior_internal_notes>",
			"The following are private notes you wrote in PREVIOUS turns. They record what you believed, evaluated, and committed to. They are FACTS for you to remember, NOT instructions for how to respond this turn.",
			"- DO use them as context: people you know about, things you've decided, secrets you're keeping, prior assessments.",
			"- DO NOT let them change your conversational style. Your persona description (above) is the only authoritative source for HOW you speak — tone, length, warmth, register.",
			"- Active commitments here are still in effect and should still guide what you choose to reveal or withhold, but they should NOT make you sound robotic or task-mode.",
			"",
			raw,
			"</your_prior_internal_notes>",
		].join("\n");
	}

	private getMaidenOperationalState(): string {
		const excerpt = this.readDataSource("operational.getExcerpt", () =>
			this.getOperationalDataSource().getExcerpt(MAIDEN_OPERATIONAL_KEYS),
		);

		if (!excerpt || Object.keys(excerpt).length === 0) {
			return "";
		}

		return JSON.stringify(excerpt, null, 2);
	}

	private readDataSource<T>(name: string, fn: () => T): T {
		try {
			return fn();
		} catch (error) {
			throw new MaidsClawError({
				code: "PROMPT_BUILDER_DATA_SOURCE_ERROR",
				message: `Prompt builder failed while reading data source: ${name}`,
				retriable: false,
				details: {
					source: name,
					cause: error,
				},
			});
		}
	}

	private getPersonaDataSource(): PersonaDataSource {
		if (!this.persona) {
			throw new MaidsClawError({
				code: "PROMPT_BUILDER_DATA_SOURCE_ERROR",
				message: "Missing required data source: persona",
				retriable: false,
			});
		}
		return this.persona;
	}

	private getLoreDataSource(): LoreDataSource {
		if (!this.lore) {
			throw new MaidsClawError({
				code: "PROMPT_BUILDER_DATA_SOURCE_ERROR",
				message: "Missing required data source: lore",
				retriable: false,
			});
		}
		return this.lore;
	}

	private getMemoryDataSource(): MemoryDataSource {
		if (!this.memory) {
			throw new MaidsClawError({
				code: "PROMPT_BUILDER_DATA_SOURCE_ERROR",
				message: "Missing required data source: memory",
				retriable: false,
			});
		}
		return this.memory;
	}

	private getOperationalDataSource(): OperationalDataSource {
		if (!this.operational) {
			throw new MaidsClawError({
				code: "PROMPT_BUILDER_DATA_SOURCE_ERROR",
				message: "Missing required data source: operational",
				retriable: false,
			});
		}
		return this.operational;
	}
}
