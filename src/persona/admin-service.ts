import { readFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "../config/atomic-writer.js";
import {
	createReloadable,
	type ReloadableSnapshot,
} from "../config/reloadable.js";
import { MaidsClawError } from "../core/errors.js";
import { type CharacterCard, isCharacterCard } from "./card-schema.js";
import { PersonaLoader } from "./loader.js";
import { PersonaService } from "./service.js";

export interface PersonaAdminService {
	listPersonas(): Promise<CharacterCard[]>;
	getPersona(personaId: string): Promise<CharacterCard | null>;
	createPersona(input: unknown): Promise<CharacterCard>;
	updatePersona(personaId: string, input: unknown): Promise<CharacterCard>;
	deletePersona(personaId: string): Promise<{ deleted: true; id: string }>;
	reloadPersonas?(): Promise<{ reloaded: true; count: number }>;
}

type PersonaAdminServiceOptions = {
	configPath: string;
	agentConfigPath: string;
};

function toMaidsClawError(
	error: unknown,
	fallbackCode: "PERSONA_LOAD_FAILED" | "INTERNAL_ERROR",
	fallbackMessage: string,
): MaidsClawError {
	if (error instanceof MaidsClawError) {
		return error;
	}

	const message = error instanceof Error ? error.message : String(error);
	return new MaidsClawError({
		code: fallbackCode,
		message: `${fallbackMessage}: ${message}`,
		retriable: false,
		details: { cause: error },
	});
}

function ensureCharacterCard(input: unknown, message: string): CharacterCard {
	if (!isCharacterCard(input)) {
		throw new MaidsClawError({
			code: "PERSONA_CARD_INVALID",
			message,
			retriable: false,
		});
	}

	return input;
}

function ensureExistingPersona(
	personas: CharacterCard[],
	personaId: string,
): CharacterCard {
	const existing = personas.find((persona) => persona.id === personaId);
	if (!existing) {
		throw new MaidsClawError({
			code: "BAD_REQUEST",
			message: `Persona not found: ${personaId}`,
			retriable: false,
			details: { status: 404 },
		});
	}

	return existing;
}

async function loadAgentPersonaReferences(
	agentConfigPath: string,
): Promise<Map<string, string[]>> {
	let raw: string;
	try {
		raw = await readFile(agentConfigPath, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return new Map();
		}
		throw toMaidsClawError(
			error,
			"PERSONA_LOAD_FAILED",
			`Failed to read agent config from ${agentConfigPath}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw toMaidsClawError(
			error,
			"PERSONA_LOAD_FAILED",
			`Invalid JSON in ${agentConfigPath}`,
		);
	}

	let entries: unknown[] = [];
	if (Array.isArray(parsed)) {
		entries = parsed;
	} else if (typeof parsed === "object" && parsed !== null) {
		const record = parsed as Record<string, unknown>;
		if (Array.isArray(record.agents)) {
			entries = record.agents;
		}
	}

	const references = new Map<string, string[]>();
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object") {
			continue;
		}

		const record = entry as Record<string, unknown>;
		const agentId =
			typeof record.id === "string" && record.id.length > 0
				? record.id
				: `agent#${i}`;
		const personaId =
			typeof record.persona_id === "string"
				? record.persona_id
				: typeof record.personaId === "string"
					? record.personaId
					: undefined;

		if (!personaId || personaId.length === 0) {
			continue;
		}

		const usedBy = references.get(personaId) ?? [];
		usedBy.push(agentId);
		references.set(personaId, usedBy);
	}

	return references;
}

export function createPersonaAdminService(
	options: PersonaAdminServiceOptions,
): PersonaAdminService {
	const personaService = new PersonaService({
		loader: new PersonaLoader(
			`${options.configPath}.unused`,
			options.configPath,
		),
	});

	const initial = personaService.loadAll();
	const snapshot: ReloadableSnapshot<CharacterCard[]> = createReloadable({
		initial,
		load: async () => {
			const result = await personaService.reload();
			if (!result.ok) {
				throw toMaidsClawError(
					result.error,
					"PERSONA_LOAD_FAILED",
					"Failed to reload personas",
				);
			}

			return [...result.snapshot.values()];
		},
	});

	const reloadPersonas = async (): Promise<{
		reloaded: true;
		count: number;
	}> => {
		const result = await snapshot.reload();
		if (!result.ok) {
			throw toMaidsClawError(
				result.error,
				"PERSONA_LOAD_FAILED",
				"Failed to reload personas",
			);
		}

		return { reloaded: true, count: result.snapshot.length };
	};

	return {
		async listPersonas(): Promise<CharacterCard[]> {
			return [...snapshot.get()];
		},

		async getPersona(personaId: string): Promise<CharacterCard | null> {
			return snapshot.get().find((persona) => persona.id === personaId) ?? null;
		},

		async createPersona(input: unknown): Promise<CharacterCard> {
			const nextCard = ensureCharacterCard(input, "Invalid persona payload");
			const current = snapshot.get();

			if (current.some((persona) => persona.id === nextCard.id)) {
				throw new MaidsClawError({
					code: "CONFLICT",
					message: `Persona already exists: ${nextCard.id}`,
					retriable: false,
				});
			}

			await writeJsonFileAtomic(options.configPath, [...current, nextCard]);
			await reloadPersonas();
			return nextCard;
		},

		async updatePersona(
			personaId: string,
			input: unknown,
		): Promise<CharacterCard> {
			const nextCard = ensureCharacterCard(input, "Invalid persona payload");
			if (nextCard.id !== personaId) {
				throw new MaidsClawError({
					code: "BAD_REQUEST",
					message: `Persona id mismatch: path '${personaId}' vs payload '${nextCard.id}'`,
					retriable: false,
				});
			}

			const current = snapshot.get();
			ensureExistingPersona(current, personaId);

			const next = current.map((persona) =>
				persona.id === personaId ? nextCard : persona,
			);

			await writeJsonFileAtomic(options.configPath, next);
			await reloadPersonas();
			return nextCard;
		},

		async deletePersona(
			personaId: string,
		): Promise<{ deleted: true; id: string }> {
			const current = snapshot.get();
			ensureExistingPersona(current, personaId);

			const references = await loadAgentPersonaReferences(
				options.agentConfigPath,
			);
			const usedBy = references.get(personaId) ?? [];
			if (usedBy.length > 0) {
				throw new MaidsClawError({
					code: "PERSONA_IN_USE",
					message: `Persona '${personaId}' is referenced by configured agents`,
					retriable: false,
					details: { persona_id: personaId, agent_ids: usedBy },
				});
			}

			const next = current.filter((persona) => persona.id !== personaId);
			await writeJsonFileAtomic(options.configPath, next);
			await reloadPersonas();
			return { deleted: true, id: personaId };
		},

		reloadPersonas,
	};
}
