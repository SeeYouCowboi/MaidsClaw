/**
 * Build-time English verb inflection generator.
 * Zero runtime deps. Combines an irregular-verb table with simple regular rules.
 *
 * Covers every lemma in the Phase-1 seed list. Future lemma additions that fall
 * outside the regular rules must be added to IRREGULAR or the build will emit
 * imperfect inflections; those imperfect cases are still safe (matcher simply
 * won't catch that inflection), but the tradeoff should be made deliberately.
 */

export const IRREGULAR_VERB_INFLECTIONS: Record<string, string[]> = {
	go: ["goes", "went", "gone", "going"],
	take: ["takes", "took", "taken", "taking"],
	hold: ["holds", "held", "holding"],
	show: ["shows", "showed", "shown", "showing"],
	put: ["puts", "putting"],
	light: ["lights", "lit", "lighted", "lighting"],
	leave: ["leaves", "left", "leaving"],
};

function regularThirdSingular(verb: string): string {
	if (/(s|x|z|ch|sh)$/.test(verb)) return verb + "es";
	if (/[^aeiou]y$/.test(verb)) return verb.slice(0, -1) + "ies";
	return verb + "s";
}

function regularPast(verb: string): string {
	if (verb.endsWith("e")) return verb + "d";
	if (/[^aeiou]y$/.test(verb)) return verb.slice(0, -1) + "ied";
	return verb + "ed";
}

function regularGerund(verb: string): string {
	if (verb.endsWith("ee")) return verb + "ing";
	if (verb.endsWith("e")) return verb.slice(0, -1) + "ing";
	return verb + "ing";
}

function inflectSingleWord(verb: string): string[] {
	if (IRREGULAR_VERB_INFLECTIONS[verb]) {
		return IRREGULAR_VERB_INFLECTIONS[verb];
	}
	return [
		regularThirdSingular(verb),
		regularPast(verb),
		regularGerund(verb),
	];
}

/**
 * Produce the inflection list for a lemma (may be a single word or a phrasal
 * verb like "pick up"). For phrasal verbs the main verb (first token) is
 * conjugated and the rest of the phrase is suffixed unchanged.
 */
export function generateInflections(lemma: string): string[] {
	const parts = lemma.split(" ");
	if (parts.length === 1) {
		return inflectSingleWord(parts[0]!);
	}
	const head = parts[0]!;
	const tail = parts.slice(1).join(" ");
	return inflectSingleWord(head).map((form) => `${form} ${tail}`);
}
