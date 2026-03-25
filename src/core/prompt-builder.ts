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

const MAIDEN_OPERATIONAL_KEYS = [
	"session.*",
	"delegation.*",
	"agent_runtime.*",
];

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
			slotContent.set(PromptSectionSlot.PERSONA, persona);
			slotContent.set(PromptSectionSlot.WORLD_RULES, this.getWorldRules());
			slotContent.set(
				PromptSectionSlot.PINNED_SHARED,
				this.getPinnedSharedBlocks(input.viewerContext.viewer_agent_id),
			);
			slotContent.set(
				PromptSectionSlot.RECENT_COGNITION,
				this.getRecentCognition(input.viewerContext),
			);
			slotContent.set(
				PromptSectionSlot.TYPED_RETRIEVAL,
				await this.getTypedRetrievalSurface(input.userMessage, input.viewerContext),
			);
			slotContent.set(
				PromptSectionSlot.LORE_ENTRIES,
				this.getLoreEntries(loreQuery),
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

	private getPinnedSharedBlocks(agentId: string): string {
		const memDs = this.getMemoryDataSource();
		const parts: string[] = [];

		const hasSplitBlocks = Boolean(memDs.getPinnedBlocks || memDs.getSharedBlocks);
		if (!hasSplitBlocks) {
		const legacyCore = this.readDataSource("memory.getCoreMemoryBlocks", () =>
				memDs.getCoreMemoryBlocks?.(agentId) ?? "",
			);
			if (legacyCore) parts.push(legacyCore);
		}

		if (memDs.getPinnedBlocks) {
			const pinned = this.readDataSource("memory.getPinnedBlocks", () =>
				memDs.getPinnedBlocks!(agentId),
			);
			if (pinned) parts.push(pinned);
		}

		if (memDs.getSharedBlocks) {
			const shared = this.readDataSource("memory.getSharedBlocks", () =>
				memDs.getSharedBlocks!(agentId),
			);
			if (shared) parts.push(shared);
		}

		if (memDs.getAttachedSharedBlocks) {
			const attached = this.readDataSource("memory.getAttachedSharedBlocks", () => {
				const result = memDs.getAttachedSharedBlocks!(agentId);
				if (result instanceof Promise) return "";
				return result;
			});
			if (attached) parts.push(attached);
		}

		return parts.join("\n");
	}

	private async getTypedRetrievalSurface(
		userMessage: string,
		viewerContext: ViewerContext,
	): Promise<string> {
		const memDs = this.getMemoryDataSource();
		if (!memDs.getTypedRetrievalSurface) {
			return "";
		}

		const result = this.readDataSource(
			"memory.getTypedRetrievalSurface",
			() => memDs.getTypedRetrievalSurface!(userMessage, viewerContext),
		);

		if (result instanceof Promise) {
			return (await result) ?? "";
		}

		return result ?? "";
	}

	private getRecentCognition(viewerContext: ViewerContext): string {
		return (
			this.readDataSource("memory.getRecentCognition", () =>
				this.getMemoryDataSource().getRecentCognition(viewerContext),
			) ?? ""
		);
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
