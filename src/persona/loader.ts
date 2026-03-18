import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MaidsClawError } from "../core/errors.js";
import { type CharacterCard, isCharacterCard } from "./card-schema.js";

export class PersonaLoader {
	private readonly personasDir: string;
	private readonly configPersonasPath?: string;

	constructor(personasDir: string = join(process.cwd(), "data", "personas"), configPersonasPath?: string) {
		this.personasDir = personasDir;
		this.configPersonasPath = configPersonasPath;
	}

	loadCards(): CharacterCard[] {
		const configCards = this.loadFromConfigFile();
		if (configCards !== undefined) {
			return configCards;
		}

		if (!existsSync(this.personasDir)) {
			return [];
		}

		const entries = readdirSync(this.personasDir, { withFileTypes: true });
		const files = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name)
			.sort();

		const cards: CharacterCard[] = [];

		for (const file of files) {
			const filePath = join(this.personasDir, file);
			let parsed: unknown;

			try {
				parsed = JSON.parse(readFileSync(filePath, "utf-8"));
			} catch (error) {
				throw new MaidsClawError({
					code: "PERSONA_LOAD_FAILED",
					message: `Failed to read persona card from ${file}`,
					retriable: false,
					details: { file, cause: error },
				});
			}

			if (!isCharacterCard(parsed)) {
				throw new MaidsClawError({
					code: "PERSONA_CARD_INVALID",
					message: `Invalid persona card schema in ${file}`,
					retriable: false,
					details: { file },
				});
			}

			cards.push(parsed);
		}

		return cards;
	}

	private loadFromConfigFile(): CharacterCard[] | undefined {
		if (!this.configPersonasPath || !existsSync(this.configPersonasPath)) {
			return undefined;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.configPersonasPath, "utf-8"));
		} catch (error) {
			throw new MaidsClawError({
				code: "PERSONA_LOAD_FAILED",
				message: `Failed to read persona config from ${this.configPersonasPath}`,
				retriable: false,
				details: { file: this.configPersonasPath, cause: error },
			});
		}

		const cards = this.normalizeConfigPersonas(parsed);
		for (let i = 0; i < cards.length; i += 1) {
			if (!isCharacterCard(cards[i])) {
				throw new MaidsClawError({
					code: "PERSONA_CARD_INVALID",
					message: `Invalid persona card schema in ${this.configPersonasPath}`,
					retriable: false,
					details: { file: this.configPersonasPath, index: i },
				});
			}
		}

		return cards;
	}

	private normalizeConfigPersonas(raw: unknown): CharacterCard[] {
		if (Array.isArray(raw)) {
			return raw;
		}

		if (isCharacterCard(raw)) {
			return [raw];
		}

		if (typeof raw === "object" && raw !== null) {
			return Object.values(raw);
		}

		throw new MaidsClawError({
			code: "PERSONA_CARD_INVALID",
			message: `Invalid persona config root in ${this.configPersonasPath}`,
			retriable: false,
			details: { file: this.configPersonasPath },
		});
	}
}
