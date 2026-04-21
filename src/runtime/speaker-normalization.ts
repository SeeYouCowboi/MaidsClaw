import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

type ActionFamily = CandidateAction["actionFamily"];

type ActionLexiconFamily = {
	en: {
		lemmas: string[];
		inflections: Record<string, string[]>;
	};
	cn: {
		tokens: string[];
	};
};

type ActionLexicon = {
	schemaVersion: number;
	generatedAt?: string;
	sourceDigests?: Record<string, string>;
	families: Record<ActionFamily, ActionLexiconFamily>;
};

const HARDCODED_FALLBACK: ActionLexicon = {
	schemaVersion: 1,
	generatedAt: "2026-04-21T00:00:00.000Z",
	sourceDigests: { fallback: "inline-hardcoded" },
	families: {
		move: {
			en: {
				lemmas: ["go", "walk", "move", "return", "enter", "leave"],
				inflections: {
					go: ["goes", "went", "gone", "going"],
					walk: ["walks", "walked", "walking"],
					move: ["moves", "moved", "moving"],
					return: ["returns", "returned", "returning"],
					enter: ["enters", "entered", "entering"],
					leave: ["leaves", "left", "leaving"],
				},
			},
			cn: { tokens: ["去", "来到", "回到", "走到", "进入", "离开"] },
		},
		possession: {
			en: {
				lemmas: ["take", "pick up", "hold", "show", "hand", "put"],
				inflections: {
					take: ["takes", "took", "taken", "taking"],
					"pick up": ["picks up", "picked up", "picking up"],
					hold: ["holds", "held", "holding"],
					show: ["shows", "showed", "shown", "showing"],
					hand: ["hands", "handed", "handing"],
					put: ["puts", "putting"],
				},
			},
			cn: { tokens: ["拿起", "拿出", "展示", "递给", "交给", "放下"] },
		},
		status_change: {
			en: {
				lemmas: ["open", "close", "lock", "unlock", "light", "extinguish"],
				inflections: {
					open: ["opens", "opened", "opening"],
					close: ["closes", "closed", "closing"],
					lock: ["locks", "locked", "locking"],
					unlock: ["unlocks", "unlocked", "unlocking"],
					light: ["lights", "lit", "lighted", "lighting"],
					extinguish: ["extinguishes", "extinguished", "extinguishing"],
				},
			},
			cn: { tokens: ["打开", "关上", "锁上", "解锁", "点亮", "熄灭"] },
		},
	},
};

function resolveLexiconPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..", "..", "data", "lexicon", "action-lexicon.json");
}

function isValidLexicon(value: unknown): value is ActionLexicon {
	if (!value || typeof value !== "object") return false;
	const root = value as Record<string, unknown>;
	if (root.schemaVersion !== 1) return false;
	const families = root.families as Record<string, unknown> | undefined;
	if (!families) return false;
	for (const family of ["move", "possession", "status_change"] as const) {
		const entry = families[family] as
			| { en?: { lemmas?: unknown; inflections?: unknown }; cn?: { tokens?: unknown } }
			| undefined;
		if (
			!entry ||
			!Array.isArray(entry.en?.lemmas) ||
			typeof entry.en?.inflections !== "object" ||
			entry.en.inflections === null ||
			!Array.isArray(entry.cn?.tokens)
		) {
			return false;
		}
	}
	return true;
}

function loadActionLexicon(): ActionLexicon {
	if (process.env.MAIDSCLAW_EXPANDED_LEXICON === "off") {
		return HARDCODED_FALLBACK;
	}
	try {
		const raw = readFileSync(resolveLexiconPath(), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isValidLexicon(parsed)) {
			console.warn("[speaker-normalization] lexicon_load_failed", {
				reason: "schema_mismatch",
			});
			return HARDCODED_FALLBACK;
		}
		return parsed;
	} catch (error) {
		console.warn("[speaker-normalization] lexicon_load_failed", {
			reason: (error as Error).message,
		});
		return HARDCODED_FALLBACK;
	}
}

const ACTION_LEXICON: ActionLexicon = loadActionLexicon();

type MatchEntry = {
	surface: string;
	lemma: string;
	family: ActionFamily;
	isChinese: boolean;
};

function isLatinSurface(value: string): boolean {
	return /^[a-z][a-z' -]*$/i.test(value);
}

function buildMatchEntries(lexicon: ActionLexicon): MatchEntry[] {
	const entries: MatchEntry[] = [];
	for (const [family, group] of Object.entries(lexicon.families) as Array<
		[ActionFamily, ActionLexiconFamily]
	>) {
		for (const lemma of group.en.lemmas) {
			entries.push({ surface: lemma, lemma, family, isChinese: false });
			const inflections = group.en.inflections[lemma] ?? [];
			for (const infl of inflections) {
				entries.push({ surface: infl, lemma, family, isChinese: false });
			}
		}
		for (const token of group.cn.tokens) {
			entries.push({ surface: token, lemma: token, family, isChinese: true });
		}
	}
	// Longest-surface-first so multi-word phrases ("pick up") beat prefixes ("pick").
	return entries.sort((a, b) => b.surface.length - a.surface.length);
}

const MATCH_ENTRIES: MatchEntry[] = buildMatchEntries(ACTION_LEXICON);

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
	verb: string;        // canonical lemma (reported to callers)
	surface: string;     // surface form that actually matched (used for target extraction)
	actionFamily: ActionFamily;
	target?: string;
	location?: string;
	resolvableTarget: boolean;
	index: number;
	source: "en-inflection" | "cn-substring" | "fallback-substring";
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
	for (const group of Object.values(ACTION_LEXICON.families)) {
		for (const lemma of group.en.lemmas) {
			const [firstToken] = lemma.split(" ");
			if (firstToken) tokens.add(firstToken);
			for (const infl of group.en.inflections[lemma] ?? []) {
				const [inflFirst] = infl.split(" ");
				if (inflFirst) tokens.add(inflFirst);
			}
		}
		for (const token of group.cn.tokens) {
			tokens.add(token);
		}
	}
	return tokens;
}

const LEXICON_FIRST_TOKENS = firstLexiconTokenSet();

function detectQuotedSpeech(raw: string): boolean {
	return QUOTED_SPEECH_RE.test(raw);
}

function surfaceRegex(surface: string): RegExp {
	if (isLatinSurface(surface)) {
		const body = escapeRegExp(surface).replace(/\s+/g, "\\s+");
		return new RegExp(`\\b${body}\\b`, "i");
	}
	return new RegExp(escapeRegExp(surface), "u");
}

function findActionMatches(raw: string, lowerText: string): ActionMatch[] {
	const perFamily = new Map<ActionFamily, ActionMatch>();

	for (const entry of MATCH_ENTRIES) {
		if (perFamily.has(entry.family)) continue;

		const re = surfaceRegex(entry.surface);
		const haystack = entry.isChinese ? raw : lowerText;
		const found = haystack.match(re);
		if (!found || found.index === undefined) continue;

		const { target, location, resolvableTarget } = extractTarget(
			raw,
			lowerText,
			entry.surface,
			entry.family,
		);

		perFamily.set(entry.family, {
			verb: entry.lemma,
			surface: entry.surface,
			actionFamily: entry.family,
			target,
			location,
			resolvableTarget,
			index: found.index,
			source: entry.isChinese ? "cn-substring" : "en-inflection",
		});
	}

	return Array.from(perFamily.values()).sort((a, b) => a.index - b.index);
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
	surface: string,
	actionFamily: ActionFamily,
): { target?: string; location?: string; resolvableTarget: boolean } {
	const verbPattern = isLatinSurface(surface)
		? escapeRegExp(surface).replace(/\s+/g, "\\s+")
		: escapeRegExp(surface);

	let target: string | undefined;

	if (isLatinSurface(surface)) {
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
	if (twoWord && isKnownSurface(twoWord)) {
		return undefined;
	}
	if (LEXICON_FIRST_TOKENS.has(first)) {
		return undefined;
	}

	return first;
}

function isKnownSurface(surface: string): boolean {
	const normalized = surface.toLowerCase();
	for (const entry of MATCH_ENTRIES) {
		if (!entry.isChinese && entry.surface.toLowerCase() === normalized) {
			return true;
		}
	}
	return false;
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

export function diagnoseActionMatch(
	rawText: string,
): Array<{ verb: string; family: ActionFamily; source: ActionMatch["source"] }> {
	const raw = typeof rawText === "string" ? rawText : "";
	const matches = findActionMatches(raw, toSearchableLower(raw));
	return matches.map((m) => ({
		verb: m.verb,
		family: m.actionFamily,
		source: m.source,
	}));
}
