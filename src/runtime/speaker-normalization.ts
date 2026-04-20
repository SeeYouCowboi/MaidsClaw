export type SpeechAct =
	| "assertion"
	| "question"
	| "hypothesis"
	| "correction"
	| "confusion_expression"
	| "quoted_speech"
	| "narrated_action";

export type ValidationSeverity = "warn" | "block";

export type NormalizedTurnInputValidation = {
	severity: ValidationSeverity;
	code: string;
	message: string;
};

export type CandidateAction = {
	verb: string;
	target?: string;
	location?: string;
	confidence: "high" | "low";
	actionFamily: "move" | "possession" | "status_change";
};

export type CandidateClaim = {
	text: string;
	writeEligible: boolean;
};

export type NormalizedTurnInput = {
	raw: string;
	speechActs: SpeechAct[];
	candidateActions: CandidateAction[];
	candidateClaims: CandidateClaim[];
	validations: NormalizedTurnInputValidation[];
	writeEligible: boolean;
};

const ACTION_LEXICON: {
	readonly [K in CandidateAction["actionFamily"]]: readonly string[];
} = {
	move: [
		"go",
		"walk",
		"move",
		"return",
		"enter",
		"leave",
		"去",
		"来到",
		"回到",
		"走到",
		"进入",
		"离开",
	],
	possession: [
		"take",
		"pick up",
		"hold",
		"show",
		"hand",
		"put",
		"拿起",
		"拿出",
		"展示",
		"递给",
		"交给",
		"放下",
	],
	status_change: [
		"open",
		"close",
		"lock",
		"unlock",
		"light",
		"extinguish",
		"打开",
		"关上",
		"锁上",
		"解锁",
		"点亮",
		"熄灭",
	],
};

const CORRECTION_PREFIX_RE =
	/(?:^|[.!?。！？]\s*)(actually|wait|其实|等等|算了)/iu;
const QUESTION_WORD_RE =
	/\b(where|what|why|how|which)\b|是不是|在哪|哪里|还是|吗|呢|吧/iu;
const QUOTED_SPEECH_RE =
	/("[^"]+"|'[^']+'|「[^」]+」|《[^》]+》|『[^』]+』)/u;

const CONFUSION_MARKERS = [
	"搞不清楚",
	"记不清",
	"不确定",
	"忘了",
	"confused",
	"not sure",
	"can't remember",
] as const;

const HYPOTHESIS_MARKERS = [
	"maybe",
	"perhaps",
	"i think",
	"应该",
	"可能",
	"也许",
	"大概",
] as const;

const AMBIGUOUS_TARGETS = new Set([
	"and",
	"something",
	"someone",
	"somewhere",
	"there",
	"here",
	"it",
	"this",
	"that",
	"thing",
	"stuff",
	"什么",
	"某处",
	"这里",
	"那里",
	"东西",
]);

const NON_ACTION_VERBS = new Set([
	"am",
	"is",
	"are",
	"was",
	"were",
	"be",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"can",
	"could",
	"would",
	"should",
	"will",
	"think",
	"know",
	"remember",
	"forget",
	"say",
	"ask",
	"wonder",
]);

type ActionMatch = {
	verb: string;
	actionFamily: CandidateAction["actionFamily"];
	target?: string;
	location?: string;
	resolvableTarget: boolean;
	index: number;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toSearchableLower(raw: string): string {
	return raw.toLowerCase().replaceAll("’", "'");
}

function addSpeechAct(speechActs: SpeechAct[], speechAct: SpeechAct): void {
	if (!speechActs.includes(speechAct)) {
		speechActs.push(speechAct);
	}
}

function containsAnyMarker(text: string, markers: readonly string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

function firstLexiconTokenSet(): Set<string> {
	const tokens = new Set<string>();
	for (const verbs of Object.values(ACTION_LEXICON)) {
		for (const verb of verbs) {
			const [firstToken] = verb.split(" ");
			if (firstToken) {
				tokens.add(firstToken);
			}
		}
	}
	return tokens;
}

const LEXICON_FIRST_TOKENS = firstLexiconTokenSet();

function detectQuotedSpeech(raw: string): boolean {
	return QUOTED_SPEECH_RE.test(raw);
}

function findActionMatches(raw: string, lowerText: string): ActionMatch[] {
	const matches: ActionMatch[] = [];

	for (const [actionFamily, verbs] of Object.entries(ACTION_LEXICON) as Array<
		[CandidateAction["actionFamily"], readonly string[]]
	>) {
		for (const verb of verbs) {
			const verbPattern = /^[a-z\s]+$/i.test(verb)
				? new RegExp(`\\b${escapeRegExp(verb).replace(/\\\s+/g, "\\\\s+")}\\b`, "i")
				: new RegExp(escapeRegExp(verb), "u");
			const found = lowerText.match(verbPattern);
			if (!found || found.index === undefined) {
				continue;
			}

			const { target, location, resolvableTarget } = extractTarget(
				raw,
				lowerText,
				verb,
				actionFamily,
			);

			matches.push({
				verb,
				actionFamily,
				target,
				location,
				resolvableTarget,
				index: found.index,
			});
			break;
		}
	}

	return matches.sort((a, b) => a.index - b.index);
}

function sanitizeTarget(target: string | undefined): string | undefined {
	if (!target) {
		return undefined;
	}
	const cleaned = target
		.trim()
		.replace(/^[\s,.;:!?，。；：！？]+/u, "")
		.replace(/[\s,.;:!?，。；：！？]+$/u, "");
	return cleaned.length > 0 ? cleaned : undefined;
}

function extractTarget(
	raw: string,
	lowerText: string,
	verb: string,
	actionFamily: CandidateAction["actionFamily"],
): { target?: string; location?: string; resolvableTarget: boolean } {
	const verbPattern = /^[a-z\s]+$/i.test(verb)
		? escapeRegExp(verb).replace(/\\\s+/g, "\\s+")
		: escapeRegExp(verb);

	let target: string | undefined;

	if (/^[a-z\s]+$/i.test(verb)) {
		const re =
			actionFamily === "move"
				? new RegExp(
					`\\b${verbPattern}\\b(?:\\s+(?:to|into|inside|towards?|back\\s+to|from|out\\s+of))?\\s+(?:the\\s+|a\\s+|an\\s+|my\\s+|your\\s+|his\\s+|her\\s+|our\\s+|their\\s+)?([a-z][a-z0-9_-]*)`,
					"i",
				)
				: new RegExp(
					`\\b${verbPattern}\\b\\s+(?:the\\s+|a\\s+|an\\s+|my\\s+|your\\s+|his\\s+|her\\s+|our\\s+|their\\s+)?([a-z][a-z0-9_-]*)`,
					"i",
				);
		target = sanitizeTarget(lowerText.match(re)?.[1]);
	} else {
		const re = new RegExp(`${verbPattern}([\\p{Script=Han}A-Za-z0-9_]{1,16})`, "u");
		target = sanitizeTarget(raw.match(re)?.[1]);
	}

	const resolvableTarget =
		typeof target === "string" && !AMBIGUOUS_TARGETS.has(target.toLowerCase());

	if (actionFamily === "move") {
		return { target, location: target, resolvableTarget };
	}

	return { target, resolvableTarget };
}

function detectUnsupportedActionVerb(lowerText: string): string | undefined {
	const firstPersonActionLike =
		lowerText.match(/\b(?:i|we)\s+([a-z]+)(?:\s+([a-z]+))?/i);
	if (!firstPersonActionLike) {
		return undefined;
	}

	const first = firstPersonActionLike[1]?.toLowerCase();
	const second = firstPersonActionLike[2]?.toLowerCase();
	if (!first || NON_ACTION_VERBS.has(first)) {
		return undefined;
	}

	const twoWord = second ? `${first} ${second}` : undefined;
	if (
		(twoWord && Object.values(ACTION_LEXICON).some((verbs) => verbs.includes(twoWord))) ||
		LEXICON_FIRST_TOKENS.has(first)
	) {
		return undefined;
	}

	return first;
}

export function normalizeTurnInput(rawText: string): NormalizedTurnInput {
	const raw = typeof rawText === "string" ? rawText : "";
	const lowerText = toSearchableLower(raw);
	const speechActs: SpeechAct[] = [];
	const validations: NormalizedTurnInputValidation[] = [];

	if (CORRECTION_PREFIX_RE.test(raw.trimStart())) {
		addSpeechAct(speechActs, "correction");
	}

	if (containsAnyMarker(lowerText, CONFUSION_MARKERS)) {
		addSpeechAct(speechActs, "confusion_expression");
	}

	if (containsAnyMarker(lowerText, HYPOTHESIS_MARKERS)) {
		addSpeechAct(speechActs, "hypothesis");
	}

	if (/[?？]\s*$/u.test(raw) || QUESTION_WORD_RE.test(lowerText)) {
		addSpeechAct(speechActs, "question");
	}

	if (detectQuotedSpeech(raw)) {
		addSpeechAct(speechActs, "quoted_speech");
	}

	const hadStepOneAct = speechActs.length > 0;
	const actionMatches = findActionMatches(raw, lowerText);
	const candidateActions: CandidateAction[] = [];

	if (actionMatches.length > 0) {
		addSpeechAct(speechActs, "narrated_action");
	}

	if (actionMatches.length > 0) {
		const firstMatch = actionMatches[0];
		const highConfidenceEligible =
			actionMatches.length === 1 && Boolean(firstMatch?.resolvableTarget);

		if (!highConfidenceEligible) {
			validations.push({
				severity: "warn",
				code: "ambiguous_action",
				message:
					actionMatches.length > 1
						? "Multiple narrated actions were detected in one input."
						: "Narrated action target is ambiguous or unresolved.",
			});
		}

		for (const match of actionMatches) {
			candidateActions.push({
				verb: match.verb,
				target: match.target,
				location: match.location,
				confidence: highConfidenceEligible ? "high" : "low",
				actionFamily: match.actionFamily,
			});
		}
	} else {
		const unsupportedVerb = detectUnsupportedActionVerb(lowerText);
		if (unsupportedVerb) {
			validations.push({
				severity: "warn",
				code: "unsupported_claim",
				message: `Unsupported action-like verb for Phase-1 lexicon: ${unsupportedVerb}`,
			});
		}
	}

	if (!hadStepOneAct && actionMatches.length === 0) {
		addSpeechAct(speechActs, "assertion");
	}

	const hasBlockingSpeechAct = speechActs.some((speechAct) =>
		[
			"question",
			"hypothesis",
			"confusion_expression",
			"quoted_speech",
		].includes(speechAct),
	);
	const correctionOnly =
		speechActs.length === 1 && speechActs[0] === "correction";
	const writeEligible =
		speechActs.includes("narrated_action") &&
		!hasBlockingSpeechAct &&
		!correctionOnly;

	const gatedCandidateActions = writeEligible
		? candidateActions
		: candidateActions.map((action) =>
				action.confidence === "high"
					? { ...action, confidence: "low" as const }
					: action,
		  );

	const candidateClaims: CandidateClaim[] =
		raw.trim().length > 0 &&
		!speechActs.includes("narrated_action") &&
		speechActs.includes("assertion")
			? [{ text: raw.trim(), writeEligible }]
			: [];

	return {
		raw,
		speechActs,
		candidateActions: gatedCandidateActions,
		candidateClaims,
		validations,
		writeEligible,
	};
}
