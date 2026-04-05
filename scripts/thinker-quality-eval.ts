#!/usr/bin/env bun
import postgres from "postgres";

type OutputFormat = "json";
type SettlementMode = "sync" | "thinker";
type CognitionKind = "assertion" | "evaluation" | "commitment";
type StanceBucket = "confident" | "tentative" | "contested";

type CliOptions = {
	rounds: number;
	output: OutputFormat;
};

type SettlementEnvelope = {
	sessionId: string;
	agentId: string;
	settlementId: string;
	committedAt: number;
	mode: SettlementMode;
	payload: Record<string, unknown>;
};

type SlotEntry = {
	settlementId: string;
	kind: CognitionKind;
	key: string;
	summary: string;
	status: "active" | "retracted";
};

type CurrentCognitionRow = {
	kind: CognitionKind;
	stance: string | null;
	summaryText: string;
};

type ModeStats = {
	upsertCounts: Record<CognitionKind, number>;
	stanceBuckets: Record<StanceBucket, number>;
	assertionCount: number;
	contestedCount: number;
	opCount: number;
	episodeCount: number;
	linkedEpisodeCount: number;
	sketchOverlapScores: number[];
};

type MetricSet = {
	cognitionOpCountParity: number;
	stanceDistributionSimilarity: number;
	conflictDetectionRate: number;
	assertionToEpisodeRatio: number;
	relationIntentCoverage: number;
	sketchUtilization: number;
};

type EvalSnapshot = {
	rounds: number;
	sampleCount: {
		sync: number;
		thinker: number;
	};
	metrics: MetricSet;
	raw: {
		sync: {
			assertions: number;
			contestedRate: number;
			opPerEpisode: number;
			relationCoverage: number;
			sketchUtilization: number;
		};
		thinker: {
			assertions: number;
			contestedRate: number;
			opPerEpisode: number;
			relationCoverage: number;
			sketchUtilization: number;
		};
	};
};

const WORD_RE = /[\p{L}\p{N}_]{2,}/gu;
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"that",
	"with",
	"this",
	"from",
	"have",
	"been",
	"will",
	"into",
	"about",
	"were",
	"your",
	"their",
	"there",
	"what",
	"when",
	"where",
	"which",
	"while",
	"then",
	"than",
	"just",
	"also",
	"only",
	"does",
	"dont",
	"it's",
	"its",
	"able",
	"should",
	"could",
	"would",
	"通过",
	"这个",
	"那个",
	"以及",
	"如果",
	"然后",
	"我们",
	"你们",
	"他们",
	"她们",
	"已经",
	"因为",
	"所以",
	"需要",
	"进行",
	"可以",
	"一个",
	"没有",
	"不是",
	"就是",
	"还是",
	"可能",
	"自己",
	"现在",
]);

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		rounds: 10,
		output: "json",
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			printHelpAndExit(0);
		}
		if (arg === "--rounds") {
			const value = argv[i + 1];
			if (!value) {
				throw new Error("--rounds requires a positive integer");
			}
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--rounds must be a positive integer");
			}
			options.rounds = n;
			i += 1;
			continue;
		}
		if (arg === "--output") {
			const value = argv[i + 1];
			if (value !== "json") {
				throw new Error("--output currently supports only 'json'");
			}
			options.output = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--rounds=")) {
			const n = Number(arg.slice("--rounds=".length));
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("--rounds must be a positive integer");
			}
			options.rounds = n;
			continue;
		}
		if (arg.startsWith("--output=")) {
			const value = arg.slice("--output=".length);
			if (value !== "json") {
				throw new Error("--output currently supports only 'json'");
			}
			options.output = value;
			continue;
		}

		throw new Error(`unknown argument: ${arg}`);
	}

	return options;
}

function printHelpAndExit(code: number): never {
	const lines = [
		"Usage: bun run scripts/thinker-quality-eval.ts [--rounds N] [--output json]",
		"",
		"Options:",
		"  --rounds N      Number of settlements per mode window (default: 10)",
		"  --output json   Emit machine-readable JSON output",
	];
	process.stdout.write(`${lines.join("\n")}\n`);
	process.exit(code);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === "string" ? value : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
	const value = obj[key];
	return typeof value === "number" ? value : undefined;
}

function isCognitionKind(value: unknown): value is CognitionKind {
	return value === "assertion" || value === "evaluation" || value === "commitment";
}

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function round4(value: number): number {
	return Number(clamp01(value).toFixed(4));
}

function ratioSimilarity(a: number, b: number): number {
	if (a === 0 && b === 0) return 1;
	if (a === 0 || b === 0) return 0;
	return clamp01(Math.min(a, b) / Math.max(a, b));
}

function rateSimilarity(a: number, b: number): number {
	return clamp01(1 - Math.abs(a - b));
}

function toStanceBucket(stance: string | null | undefined): StanceBucket | null {
	if (!stance) return null;
	if (stance === "accepted" || stance === "confirmed") return "confident";
	if (stance === "tentative" || stance === "hypothetical") return "tentative";
	if (stance === "contested") return "contested";
	return null;
}

function parseStanceFromSummary(summary: string): string | null {
	const match = summary.match(/\(([^()]+)\)\s*$/);
	if (!match) return null;
	return match[1]?.trim() ?? null;
}

function extractKeywords(text: string, maxKeywords = 20): Set<string> {
	const counts = new Map<string, number>();
	const lowered = text.toLowerCase();
	const matches = lowered.matchAll(WORD_RE);
	for (const match of matches) {
		const token = match[0];
		if (!token || token.length < 2) continue;
		if (STOPWORDS.has(token)) continue;
		if (/^\d+$/.test(token)) continue;
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}

	const ordered = [...counts.entries()]
		.sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1];
			return a[0].localeCompare(b[0]);
		})
		.slice(0, maxKeywords)
		.map(([token]) => token);

	return new Set(ordered);
}

function sketchOverlapScore(sketch: string, output: string): number | null {
	const sketchKeywords = extractKeywords(sketch);
	if (sketchKeywords.size === 0) {
		return null;
	}
	const outputKeywords = extractKeywords(output, 50);
	let overlap = 0;
	for (const token of sketchKeywords) {
		if (outputKeywords.has(token)) {
			overlap += 1;
		}
	}
	return clamp01(overlap / sketchKeywords.size);
}

function keyOf(agentId: string, settlementId: string): string {
	return `${agentId}::${settlementId}`;
}

function cognitionKeyOf(agentId: string, cognitionKey: string): string {
	return `${agentId}::${cognitionKey}`;
}

function parseSettlementRows(
	rows: Array<{ session_id: string; committed_at: number | string; payload: unknown }>,
): SettlementEnvelope[] {
	const settlements: SettlementEnvelope[] = [];

	for (const row of rows) {
		const payload = toRecord(row.payload);
		if (!payload) continue;

		const settlementId = readString(payload, "settlementId");
		const ownerAgentId = readString(payload, "ownerAgentId");
		if (!settlementId || !ownerAgentId) continue;

		const talkerTurnVersion = readNumber(payload, "talkerTurnVersion");
		const privateCognition = toRecord(payload.privateCognition);
		const hasPrivateCognitionOps =
			privateCognition !== undefined && Array.isArray(privateCognition.ops);

		let mode: SettlementMode | null = null;
		if (typeof talkerTurnVersion === "number") {
			mode = "thinker";
		} else if (hasPrivateCognitionOps) {
			mode = "sync";
		}
		if (!mode) continue;

		settlements.push({
			sessionId: row.session_id,
			agentId: ownerAgentId,
			settlementId,
			committedAt: Number(row.committed_at),
			mode,
			payload,
		});
	}

	settlements.sort((a, b) => a.committedAt - b.committedAt);
	return settlements;
}

function parseSlotMap(
	rows: Array<{ agent_id: string; slot_payload: unknown }>,
): Map<string, SlotEntry[]> {
	const map = new Map<string, SlotEntry[]>();
	for (const row of rows) {
		if (!Array.isArray(row.slot_payload)) continue;
		const agentId = row.agent_id;
		for (const entryRaw of row.slot_payload) {
			const entry = toRecord(entryRaw);
			if (!entry) continue;
			const settlementId = readString(entry, "settlementId");
			const kind = entry.kind;
			const key = readString(entry, "key");
			const summary = readString(entry, "summary") ?? "";
			const status = readString(entry, "status") === "retracted" ? "retracted" : "active";
			if (!settlementId || !key || !isCognitionKind(kind)) {
				continue;
			}

			const mapKey = keyOf(agentId, settlementId);
			const arr = map.get(mapKey) ?? [];
			arr.push({ settlementId, kind, key, summary, status });
			map.set(mapKey, arr);
		}
	}
	return map;
}

function average(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function parseSyncModeStats(settlements: SettlementEnvelope[]): ModeStats {
	const stats: ModeStats = {
		upsertCounts: { assertion: 0, evaluation: 0, commitment: 0 },
		stanceBuckets: { confident: 0, tentative: 0, contested: 0 },
		assertionCount: 0,
		contestedCount: 0,
		opCount: 0,
		episodeCount: 0,
		linkedEpisodeCount: 0,
		sketchOverlapScores: [],
	};

	for (const settlement of settlements) {
		const payload = settlement.payload;
		const privateCognition = toRecord(payload.privateCognition);
		const ops = privateCognition && Array.isArray(privateCognition.ops)
			? privateCognition.ops
			: [];

		const outputFragments: string[] = [];
		for (const opRaw of ops) {
			const op = toRecord(opRaw);
			if (!op) continue;
			if (op.op !== "upsert") continue;
			const record = toRecord(op.record);
			if (!record) continue;
			const kind = record.kind;
			if (!isCognitionKind(kind)) continue;

			stats.upsertCounts[kind] += 1;
			stats.opCount += 1;
			outputFragments.push(JSON.stringify(record));

			if (kind === "assertion") {
				stats.assertionCount += 1;
				const stance = readString(record, "stance") ?? null;
				if (stance === "contested") {
					stats.contestedCount += 1;
				}
				const bucket = toStanceBucket(stance);
				if (bucket) {
					stats.stanceBuckets[bucket] += 1;
				}
			}
		}

		const episodes = Array.isArray(payload.privateEpisodes)
			? payload.privateEpisodes
			: [];
		stats.episodeCount += episodes.length;

		const relationIntents = Array.isArray(payload.relationIntents)
			? payload.relationIntents
			: [];
		const linkedSourceRefs = new Set<string>();
		for (const intentRaw of relationIntents) {
			const intent = toRecord(intentRaw);
			if (!intent) continue;
			const intentType = readString(intent, "intent");
			if (intentType !== "supports" && intentType !== "triggered") continue;
			const sourceRef = readString(intent, "sourceRef");
			if (sourceRef) linkedSourceRefs.add(sourceRef);
		}

		let linkedEpisodeCount = 0;
		for (const episodeRaw of episodes) {
			const episode = toRecord(episodeRaw);
			if (!episode) continue;
			const localRef = readString(episode, "localRef");
			if (localRef && linkedSourceRefs.has(localRef)) {
				linkedEpisodeCount += 1;
			}
		}
		stats.linkedEpisodeCount += linkedEpisodeCount;

		const sketch = readString(payload, "cognitiveSketch") ?? "";
		if (sketch.trim().length > 0 && outputFragments.length > 0) {
			const overlap = sketchOverlapScore(sketch, outputFragments.join(" "));
			if (overlap !== null) {
				stats.sketchOverlapScores.push(overlap);
			}
		}
	}

	return stats;
}

function parseThinkerModeStats(params: {
	settlements: SettlementEnvelope[];
	slotMap: Map<string, SlotEntry[]>;
	cognitionCurrentMap: Map<string, CurrentCognitionRow>;
	episodeCountMap: Map<string, number>;
	linkedEpisodeCountMap: Map<string, number>;
}): ModeStats {
	const { settlements, slotMap, cognitionCurrentMap, episodeCountMap, linkedEpisodeCountMap } = params;
	const stats: ModeStats = {
		upsertCounts: { assertion: 0, evaluation: 0, commitment: 0 },
		stanceBuckets: { confident: 0, tentative: 0, contested: 0 },
		assertionCount: 0,
		contestedCount: 0,
		opCount: 0,
		episodeCount: 0,
		linkedEpisodeCount: 0,
		sketchOverlapScores: [],
	};

	for (const settlement of settlements) {
		const mapKey = keyOf(settlement.agentId, settlement.settlementId);
		const entries = slotMap.get(mapKey) ?? [];
		const outputFragments: string[] = [];

		for (const entry of entries) {
			if (entry.status === "retracted") continue;
			stats.upsertCounts[entry.kind] += 1;
			stats.opCount += 1;

			const current = cognitionCurrentMap.get(cognitionKeyOf(settlement.agentId, entry.key));
			outputFragments.push(current?.summaryText ?? entry.summary);

			if (entry.kind === "assertion") {
				stats.assertionCount += 1;
				const stance = current?.stance ?? parseStanceFromSummary(entry.summary);
				if (stance === "contested") {
					stats.contestedCount += 1;
				}
				const bucket = toStanceBucket(stance);
				if (bucket) {
					stats.stanceBuckets[bucket] += 1;
				}
			}
		}

		const episodeCount = episodeCountMap.get(mapKey) ?? 0;
		const linkedEpisodeCount = linkedEpisodeCountMap.get(settlement.settlementId) ?? 0;
		stats.episodeCount += episodeCount;
		stats.linkedEpisodeCount += Math.min(linkedEpisodeCount, episodeCount);

		const sketch = readString(settlement.payload, "cognitiveSketch") ?? "";
		if (sketch.trim().length > 0 && outputFragments.length > 0) {
			const overlap = sketchOverlapScore(sketch, outputFragments.join(" "));
			if (overlap !== null) {
				stats.sketchOverlapScores.push(overlap);
			}
		}
	}

	return stats;
}

function distributionSimilarity(
	a: Record<StanceBucket, number>,
	b: Record<StanceBucket, number>,
): number {
	const totalA = a.confident + a.tentative + a.contested;
	const totalB = b.confident + b.tentative + b.contested;
	if (totalA === 0 && totalB === 0) return 1;
	if (totalA === 0 || totalB === 0) return 0;

	const pa = {
		confident: a.confident / totalA,
		tentative: a.tentative / totalA,
		contested: a.contested / totalA,
	};
	const pb = {
		confident: b.confident / totalB,
		tentative: b.tentative / totalB,
		contested: b.contested / totalB,
	};

	const distance =
		Math.abs(pa.confident - pb.confident) +
		Math.abs(pa.tentative - pb.tentative) +
		Math.abs(pa.contested - pb.contested);

	return clamp01(1 - distance / 2);
}

function toRawSummary(stats: ModeStats) {
	const contestedRate =
		stats.assertionCount > 0 ? stats.contestedCount / stats.assertionCount : 0;
	const opPerEpisode = stats.episodeCount > 0 ? stats.opCount / stats.episodeCount : 0;
	const relationCoverage =
		stats.episodeCount > 0 ? stats.linkedEpisodeCount / stats.episodeCount : 0;
	const sketchUtilization = average(stats.sketchOverlapScores);

	return {
		assertions: stats.assertionCount,
		contestedRate: round4(contestedRate),
		opPerEpisode: round4(opPerEpisode),
		relationCoverage: round4(relationCoverage),
		sketchUtilization: round4(sketchUtilization),
	};
}

function evaluateWindow(params: {
	rounds: number;
	syncSettlements: SettlementEnvelope[];
	thinkerSettlements: SettlementEnvelope[];
	slotMap: Map<string, SlotEntry[]>;
	cognitionCurrentMap: Map<string, CurrentCognitionRow>;
	episodeCountMap: Map<string, number>;
	linkedEpisodeCountMap: Map<string, number>;
}): EvalSnapshot {
	const syncStats = parseSyncModeStats(params.syncSettlements);
	const thinkerStats = parseThinkerModeStats({
		settlements: params.thinkerSettlements,
		slotMap: params.slotMap,
		cognitionCurrentMap: params.cognitionCurrentMap,
		episodeCountMap: params.episodeCountMap,
		linkedEpisodeCountMap: params.linkedEpisodeCountMap,
	});

	const kindParity = average([
		ratioSimilarity(syncStats.upsertCounts.assertion, thinkerStats.upsertCounts.assertion),
		ratioSimilarity(syncStats.upsertCounts.evaluation, thinkerStats.upsertCounts.evaluation),
		ratioSimilarity(syncStats.upsertCounts.commitment, thinkerStats.upsertCounts.commitment),
	]);

	const syncConflictRate =
		syncStats.assertionCount > 0
			? syncStats.contestedCount / syncStats.assertionCount
			: 0;
	const thinkerConflictRate =
		thinkerStats.assertionCount > 0
			? thinkerStats.contestedCount / thinkerStats.assertionCount
			: 0;

	const syncDensity = syncStats.episodeCount > 0 ? syncStats.opCount / syncStats.episodeCount : 0;
	const thinkerDensity =
		thinkerStats.episodeCount > 0
			? thinkerStats.opCount / thinkerStats.episodeCount
			: 0;

	const syncCoverage =
		syncStats.episodeCount > 0
			? syncStats.linkedEpisodeCount / syncStats.episodeCount
			: 0;
	const thinkerCoverage =
		thinkerStats.episodeCount > 0
			? thinkerStats.linkedEpisodeCount / thinkerStats.episodeCount
			: 0;

	const syncSketchUtilization = average(syncStats.sketchOverlapScores);
	const thinkerSketchUtilization = average(thinkerStats.sketchOverlapScores);

	const metrics: MetricSet = {
		cognitionOpCountParity: round4(kindParity),
		stanceDistributionSimilarity: round4(
			distributionSimilarity(syncStats.stanceBuckets, thinkerStats.stanceBuckets),
		),
		conflictDetectionRate: round4(rateSimilarity(syncConflictRate, thinkerConflictRate)),
		assertionToEpisodeRatio: round4(ratioSimilarity(syncDensity, thinkerDensity)),
		relationIntentCoverage: round4(rateSimilarity(syncCoverage, thinkerCoverage)),
		sketchUtilization: round4(
			rateSimilarity(syncSketchUtilization, thinkerSketchUtilization),
		),
	};

	return {
		rounds: params.rounds,
		sampleCount: {
			sync: params.syncSettlements.length,
			thinker: params.thinkerSettlements.length,
		},
		metrics,
		raw: {
			sync: toRawSummary(syncStats),
			thinker: toRawSummary(thinkerStats),
		},
	};
}

function chooseWindows(params: {
	rounds: number;
	syncSettlements: SettlementEnvelope[];
	thinkerSettlements: SettlementEnvelope[];
}): {
	baseline: { sync: SettlementEnvelope[]; thinker: SettlementEnvelope[]; rounds: number };
	iteration1?: { sync: SettlementEnvelope[]; thinker: SettlementEnvelope[]; rounds: number };
} {
	const { rounds, syncSettlements, thinkerSettlements } = params;
	const paired = Math.min(syncSettlements.length, thinkerSettlements.length);
	if (paired === 0) {
		throw new Error("No comparable sync/thinker settlement data found");
	}

	if (paired >= rounds * 2) {
		const baselineSync = syncSettlements.slice(-rounds * 2, -rounds);
		const baselineThinker = thinkerSettlements.slice(-rounds * 2, -rounds);
		const iterSync = syncSettlements.slice(-rounds);
		const iterThinker = thinkerSettlements.slice(-rounds);
		return {
			baseline: { sync: baselineSync, thinker: baselineThinker, rounds },
			iteration1: { sync: iterSync, thinker: iterThinker, rounds },
		};
	}

	const useCount = Math.min(rounds, paired);
	return {
		baseline: {
			sync: syncSettlements.slice(-useCount),
			thinker: thinkerSettlements.slice(-useCount),
			rounds: useCount,
		},
	};
}

function getDbUrl(): string | null {
	return process.env.PG_TEST_URL ?? process.env.DATABASE_URL ?? null;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const dbUrl = getDbUrl();
	if (!dbUrl) {
		process.stderr.write(
			"Missing database URL. Set PG_TEST_URL or DATABASE_URL, then rerun.\n",
		);
		process.stderr.write(
			"Example: PG_TEST_URL=postgres://user:pass@127.0.0.1:5432/db bun run scripts/thinker-quality-eval.ts --rounds 10 --output json\n",
		);
		process.exit(1);
	}

	const sql = postgres(dbUrl, { max: 2 });
	const warnings: string[] = [];

	try {
		const scanLimit = Math.max(options.rounds * 60, 400);

		const settlementRows = await sql<
			Array<{ session_id: string; committed_at: number | string; payload: unknown }>
		>`
			SELECT session_id, committed_at, payload
			FROM interaction_records
			WHERE record_type = 'turn_settlement'
			ORDER BY committed_at DESC
			LIMIT ${scanLimit}
		`;

		const settlements = parseSettlementRows(settlementRows);

		const slotRows = await sql<Array<{ agent_id: string; slot_payload: unknown }>>`
			SELECT agent_id, slot_payload
			FROM recent_cognition_slots
		`;
		const slotMap = parseSlotMap(slotRows);

		const thinkerSettlementsAll = settlements.filter((s) => s.mode === "thinker");
		const syncSettlements = settlements.filter((s) => s.mode === "sync");

		const thinkerSettlements = thinkerSettlementsAll.filter((s) => {
			const entries = slotMap.get(keyOf(s.agentId, s.settlementId)) ?? [];
			return entries.length > 0;
		});

		if (thinkerSettlements.length < thinkerSettlementsAll.length) {
			warnings.push(
				`Filtered ${thinkerSettlementsAll.length - thinkerSettlements.length} thinker settlements without slot_payload entries`,
			);
		}

		const involvedAgentIds = [...new Set(settlements.map((s) => s.agentId))];
		const cognitionCurrentMap = new Map<string, CurrentCognitionRow>();
		if (involvedAgentIds.length > 0) {
			const cognitionRows = await sql<
				Array<{
					agent_id: string;
					cognition_key: string;
					kind: string;
					stance: string | null;
					summary_text: string | null;
				}>
			>`
				SELECT agent_id, cognition_key, kind, stance, summary_text
				FROM private_cognition_current
				WHERE agent_id = ANY(${sql.array(involvedAgentIds)})
			`;

			for (const row of cognitionRows) {
				if (!isCognitionKind(row.kind)) continue;
				cognitionCurrentMap.set(cognitionKeyOf(row.agent_id, row.cognition_key), {
					kind: row.kind,
					stance: row.stance,
					summaryText: row.summary_text ?? "",
				});
			}
		}

		const thinkerSettlementIds = [...new Set(thinkerSettlements.map((s) => s.settlementId))];
		const episodeCountMap = new Map<string, number>();
		if (thinkerSettlementIds.length > 0) {
			try {
				const episodeRows = await sql<
					Array<{ settlement_id: string; agent_id: string; episode_count: number | string }>
				>`
					SELECT settlement_id, agent_id, COUNT(*)::int AS episode_count
					FROM private_episode_events
					WHERE settlement_id = ANY(${sql.array(thinkerSettlementIds)})
					GROUP BY settlement_id, agent_id
				`;
				for (const row of episodeRows) {
					episodeCountMap.set(
						keyOf(row.agent_id, row.settlement_id),
						Number(row.episode_count),
					);
				}
			} catch (error: unknown) {
				warnings.push(
					`Episode lookup failed (private_episode_events unavailable?): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		const linkedEpisodeCountMap = new Map<string, number>();
		if (thinkerSettlementIds.length > 0) {
			try {
				const relationRows = await sql<
					Array<{ settlement_id: string; linked_episode_count: number | string }>
				>`
					SELECT source_ref AS settlement_id,
					       COUNT(DISTINCT source_node_ref)::int AS linked_episode_count
					FROM memory_relations
					WHERE source_kind = 'turn'
					  AND relation_type IN ('supports', 'triggered')
					  AND source_ref = ANY(${sql.array(thinkerSettlementIds)})
					  AND source_node_ref LIKE 'private_episode:%'
					GROUP BY source_ref
				`;

				for (const row of relationRows) {
					linkedEpisodeCountMap.set(row.settlement_id, Number(row.linked_episode_count));
				}
			} catch (error: unknown) {
				warnings.push(
					`Relation coverage lookup failed (memory_relations unavailable?): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		const windows = chooseWindows({
			rounds: options.rounds,
			syncSettlements,
			thinkerSettlements,
		});

		const baseline = evaluateWindow({
			rounds: windows.baseline.rounds,
			syncSettlements: windows.baseline.sync,
			thinkerSettlements: windows.baseline.thinker,
			slotMap,
			cognitionCurrentMap,
			episodeCountMap,
			linkedEpisodeCountMap,
		});

		const iteration1 = windows.iteration1
			? evaluateWindow({
				rounds: windows.iteration1.rounds,
				syncSettlements: windows.iteration1.sync,
				thinkerSettlements: windows.iteration1.thinker,
				slotMap,
				cognitionCurrentMap,
				episodeCountMap,
				linkedEpisodeCountMap,
			})
			: undefined;

		const latestMetrics = iteration1?.metrics ?? baseline.metrics;
		const metricKeys = Object.keys(baseline.metrics) as Array<keyof MetricSet>;
		const weakestMetric = metricKeys.reduce((prev, cur) =>
			baseline.metrics[cur] < baseline.metrics[prev] ? cur : prev,
		);

		const iterationImprovement = iteration1
			? Object.fromEntries(
					metricKeys.map((key) => [
						key,
						Number((iteration1.metrics[key] - baseline.metrics[key]).toFixed(4)),
					]),
				)
			: undefined;

		const result = {
			metrics: latestMetrics,
			baseline,
			...(iteration1
				? {
						iteration1: {
							...iteration1,
							improvement: iterationImprovement,
							targetedMetric: weakestMetric,
							targetedMetricImproved:
								iterationImprovement &&
								typeof iterationImprovement[weakestMetric] === "number"
									? (iterationImprovement[weakestMetric] as number) > 0
									: false,
						},
					}
				: {}),
			meta: {
				generatedAt: new Date().toISOString(),
				roundsRequested: options.rounds,
				settlementsScanned: settlements.length,
				syncSettlementsFound: syncSettlements.length,
				thinkerSettlementsFound: thinkerSettlements.length,
				weakestBaselineMetric: weakestMetric,
			},
			warnings,
		};

		if (options.output === "json") {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error: unknown) => {
	const msg = error instanceof Error ? error.stack ?? error.message : String(error);
	process.stderr.write(`[thinker-quality-eval] FATAL: ${msg}\n`);
	process.exit(1);
});
