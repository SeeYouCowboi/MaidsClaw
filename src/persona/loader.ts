import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MaidsClawError } from "../core/errors.js";
import { type CharacterCard, isCharacterCard } from "./card-schema.js";

export class PersonaLoader {
	private readonly personasDir: string;

	constructor(personasDir: string = join(process.cwd(), "data", "personas")) {
		this.personasDir = personasDir;
	}

	loadCards(): CharacterCard[] {
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
}
