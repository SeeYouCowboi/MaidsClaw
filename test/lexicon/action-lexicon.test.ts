import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const LEXICON_PATH = resolve(
	import.meta.dir,
	"..",
	"..",
	"data",
	"lexicon",
	"action-lexicon.json",
);

const SCHEMA_PATH = resolve(
	import.meta.dir,
	"..",
	"..",
	"data",
	"lexicon",
	"action-lexicon.schema.json",
);

type Lexicon = {
	schemaVersion: number;
	generatedAt: string;
	sourceDigests: Record<string, string>;
	families: Record<
		"move" | "possession" | "status_change",
		{
			en: { lemmas: string[]; inflections: Record<string, string[]> };
			cn: { tokens: string[] };
		}
	>;
};

function loadLexicon(): Lexicon {
	const raw = readFileSync(LEXICON_PATH, "utf-8");
	return JSON.parse(raw) as Lexicon;
}

describe("data/lexicon/action-lexicon.json", () => {
	it("loads and matches schema shape", () => {
		const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
		expect(schema.title).toContain("Action Lexicon");

		const lex = loadLexicon();
		expect(lex.schemaVersion).toBe(1);
		expect(typeof lex.generatedAt).toBe("string");
		expect(typeof lex.sourceDigests).toBe("object");
		expect(Object.keys(lex.sourceDigests).length).toBeGreaterThan(0);

		for (const family of ["move", "possession", "status_change"] as const) {
			const group = lex.families[family];
			expect(Array.isArray(group.en.lemmas)).toBe(true);
			expect(group.en.lemmas.length).toBeGreaterThan(0);
			expect(typeof group.en.inflections).toBe("object");
			expect(Array.isArray(group.cn.tokens)).toBe(true);
			expect(group.cn.tokens.length).toBeGreaterThan(0);
		}
	});

	it("backward-compat invariant: every hardcoded lemma is present", () => {
		const lex = loadLexicon();

		const requiredMove = [
			"go",
			"walk",
			"move",
			"return",
			"enter",
			"leave",
		];
		const requiredPossession = [
			"take",
			"pick up",
			"hold",
			"show",
			"hand",
			"put",
		];
		const requiredStatus = [
			"open",
			"close",
			"lock",
			"unlock",
			"light",
			"extinguish",
		];
		const requiredMoveCn = ["去", "来到", "回到", "走到", "进入", "离开"];
		const requiredPossessionCn = [
			"拿起",
			"拿出",
			"展示",
			"递给",
			"交给",
			"放下",
		];
		const requiredStatusCn = [
			"打开",
			"关上",
			"锁上",
			"解锁",
			"点亮",
			"熄灭",
		];

		for (const lemma of requiredMove) {
			expect(lex.families.move.en.lemmas).toContain(lemma);
		}
		for (const lemma of requiredPossession) {
			expect(lex.families.possession.en.lemmas).toContain(lemma);
		}
		for (const lemma of requiredStatus) {
			expect(lex.families.status_change.en.lemmas).toContain(lemma);
		}
		for (const tok of requiredMoveCn) {
			expect(lex.families.move.cn.tokens).toContain(tok);
		}
		for (const tok of requiredPossessionCn) {
			expect(lex.families.possession.cn.tokens).toContain(tok);
		}
		for (const tok of requiredStatusCn) {
			expect(lex.families.status_change.cn.tokens).toContain(tok);
		}
	});

	it("each English lemma has a non-empty inflection list (incl. lemma itself or variants)", () => {
		const lex = loadLexicon();
		for (const family of ["move", "possession", "status_change"] as const) {
			for (const lemma of lex.families[family].en.lemmas) {
				const inflections = lex.families[family].en.inflections[lemma];
				expect(Array.isArray(inflections)).toBe(true);
				// Every lemma in current dataset has at least two inflections.
				expect((inflections ?? []).length).toBeGreaterThanOrEqual(1);
			}
		}
	});
});
