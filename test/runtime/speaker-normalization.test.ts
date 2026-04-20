import { describe, expect, it } from "bun:test";
import { normalizeTurnInput } from "../../src/runtime/speaker-normalization.js";

describe("normalizeTurnInput", () => {
	it("T80 fixture: correction/confusion/hypothesis/question stays non-writeable and action-free", () => {
		const result = normalizeTurnInput(
			"其实我记不清了，可能昨天的事我搞不清楚？",
		);

		expect(result.speechActs).toContain("correction");
		expect(result.speechActs).toContain("confusion_expression");
		expect(result.speechActs).toContain("hypothesis");
		expect(result.speechActs).toContain("question");
		expect(result.writeEligible).toBe(false);
		expect(result.candidateActions).toEqual([]);
		expect(
			result.candidateActions.filter((action) => action.confidence === "high"),
		).toHaveLength(0);
	});

	it("emits unsupported_claim for unsupported action-like verb", () => {
		const result = normalizeTurnInput("I scream at the guard");

		expect(result.validations.some((v) => v.code === "unsupported_claim")).toBe(
			true,
		);
		expect(
			result.candidateActions.filter((action) => action.confidence === "high"),
		).toHaveLength(0);
	});

	it("emits ambiguous_action when narrated action target is unresolved", () => {
		const result = normalizeTurnInput("I go and do something");

		expect(result.speechActs).toContain("narrated_action");
		expect(result.validations.some((v) => v.code === "ambiguous_action")).toBe(
			true,
		);
		expect(result.candidateActions).toHaveLength(1);
		expect(result.candidateActions[0]?.confidence).toBe("low");
		expect(result.writeEligible).toBe(true);
	});

	it("recognizes valid narrated action in English", () => {
		const result = normalizeTurnInput("I pick up the watch");

		expect(result.speechActs).toEqual(["narrated_action"]);
		expect(result.writeEligible).toBe(true);
		expect(result.candidateActions).toHaveLength(1);
		expect(result.candidateActions[0]).toMatchObject({
			verb: "pick up",
			actionFamily: "possession",
			confidence: "high",
			target: "watch",
		});
	});

	it("recognizes valid narrated action in Chinese", () => {
		const result = normalizeTurnInput("我拿起手表");

		expect(result.speechActs).toEqual(["narrated_action"]);
		expect(result.writeEligible).toBe(true);
		expect(result.candidateActions).toHaveLength(1);
		expect(result.candidateActions[0]).toMatchObject({
			verb: "拿起",
			actionFamily: "possession",
			confidence: "high",
			target: "手表",
		});
	});

	it("question inputs are not write-eligible", () => {
		const result = normalizeTurnInput("What is in the room?");

		expect(result.speechActs).toContain("question");
		expect(result.writeEligible).toBe(false);
	});

	it("hypothesis inputs are not write-eligible", () => {
		const result = normalizeTurnInput("Maybe the key is on the table");

		expect(result.speechActs).toContain("hypothesis");
		expect(result.writeEligible).toBe(false);
	});

	it("quoted speech inputs are not write-eligible", () => {
		const result = normalizeTurnInput('I say "hello"');

		expect(result.speechActs).toContain("quoted_speech");
		expect(result.writeEligible).toBe(false);
	});
});
