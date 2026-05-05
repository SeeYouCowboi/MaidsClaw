import type postgres from "postgres";
import { containsCjk, tokenizeQuery } from "../../../memory/query-tokenizer.js";
import { mergeSignalCandidates } from "../../../memory/retrieval/candidate-merge.js";
import type {
	RetrievalSignal,
	SignalCandidate,
} from "../../../memory/retrieval/search-backend-contract.js";

const LATIN_CHAR_RE = /[A-Za-z]/u;
const NGRAM_FALLBACK_HIT_FLOOR = 3;
const NGRAM_FALLBACK_MAX_LIMIT = 10;

type SqlParam = string | number | boolean | null | string[] | number[];

type BuiltPgSearchSql = {
	text: string;
	params: SqlParam[];
};

export type PgSearchRoutingDecision = {
	useJieba: boolean;
	tokenCount: number;
	isMixedScript: boolean;
	shouldRunNgram: boolean;
	ngramLimit: number;
};

export type BuildCognitionWordSqlOptions = {
	query: string;
	agentId: string;
	limit: number;
	useJieba: boolean;
	useAliasSyntax?: boolean;
	kind?: string;
	stance?: string;
	basis?: string;
	activeOnly?: boolean;
	asOfCommittedTime?: number;
	minScore?: number;
};

export type BuildCognitionNgramSqlOptions = Omit<
	BuildCognitionWordSqlOptions,
	"useJieba"
>;

export type BuildEpisodeWordSqlOptions = {
	query: string;
	agentId: string;
	limit: number;
	useJieba: boolean;
	useAliasSyntax?: boolean;
	category?: string;
	asOfCommittedTime?: number;
	minScore?: number;
};

export type BuildEpisodeNgramSqlOptions = Omit<
	BuildEpisodeWordSqlOptions,
	"useJieba"
>;

export type BuildAreaWordSqlOptions = {
	query: string;
	locationEntityId: number;
	limit: number;
	useJieba: boolean;
	useAliasSyntax?: boolean;
	entityIds?: number[];
	asOfCreatedTime?: number;
	minScore?: number;
};

export type BuildAreaNgramSqlOptions = Omit<
	BuildAreaWordSqlOptions,
	"useJieba"
>;

export type BuildWorldWordSqlOptions = {
	query: string;
	limit: number;
	useJieba: boolean;
	useAliasSyntax?: boolean;
	asOfCreatedTime?: number;
	minScore?: number;
};

export type BuildWorldNgramSqlOptions = Omit<
	BuildWorldWordSqlOptions,
	"useJieba"
>;

export type PgSearchCognitionQuery = {
	query: string;
	agentId: string;
	limit?: number;
	minScore?: number;
	kind?: string;
	stance?: string;
	basis?: string;
	activeOnly?: boolean;
	asOfCommittedTime?: number;
};

export type PgSearchEpisodeQuery = {
	query: string;
	agentId: string;
	limit?: number;
	minScore?: number;
	category?: string;
	asOfCommittedTime?: number;
};

export type PgSearchAreaQuery = {
	query: string;
	locationEntityId: number;
	limit?: number;
	minScore?: number;
	entityIds?: number[];
	asOfCreatedTime?: number;
};

export type PgSearchWorldQuery = {
	query: string;
	limit?: number;
	minScore?: number;
	asOfCreatedTime?: number;
};

export type CognitionSearchPgRow = {
	source_ref: string;
	kind: string;
	basis: string | null;
	stance: string | null;
	content: string;
	updated_at: string | number;
	score: number;
};

export type EpisodeSearchPgRow = {
	id: string | number;
	source_ref: string;
	agent_id: string;
	doc_type: string;
	category: string;
	content: string;
	committed_at: string | number;
	created_at: string | number;
	actor: string | null;
	score: number;
};

export type AreaSearchPgRow = {
	id: string | number;
	source_ref: string;
	location_entity_id: number;
	doc_type: string;
	content: string;
	created_at: string | number;
	score: number;
};

export type WorldSearchPgRow = {
	id: string | number;
	source_ref: string;
	doc_type: string;
	content: string;
	created_at: string | number;
	score: number;
};

type CognitionQueryRawRow = Omit<CognitionSearchPgRow, "score"> & {
	score: string | number;
};

type EpisodeQueryRawRow = Omit<EpisodeSearchPgRow, "score"> & {
	score: string | number;
};

type AreaQueryRawRow = Omit<AreaSearchPgRow, "score"> & {
	score: string | number;
};

type WorldQueryRawRow = Omit<WorldSearchPgRow, "score"> & {
	score: string | number;
};

function toNumber(value: string | number | null | undefined): number {
	if (value == null) {
		return 0;
	}
	return typeof value === "number" ? value : Number(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function hasMixedCjkAndLatin(query: string): boolean {
	return containsCjk(query) && LATIN_CHAR_RE.test(query);
}

export function decidePgSearchRouting(
	query: string,
	primaryHitCount: number,
	limit: number,
): PgSearchRoutingDecision {
	const trimmed = query.trim();
	const tokenCount = tokenizeQuery(trimmed).length;
	const isMixedScript = hasMixedCjkAndLatin(trimmed);
	const shouldRunNgram =
		tokenCount === 0 ||
		trimmed.length <= 4 ||
		isMixedScript ||
		primaryHitCount < NGRAM_FALLBACK_HIT_FLOOR;

	return {
		useJieba: containsCjk(trimmed),
		tokenCount,
		isMixedScript,
		shouldRunNgram,
		ngramLimit: Math.max(
			1,
			Math.min(Math.max(1, limit), NGRAM_FALLBACK_MAX_LIMIT),
		),
	};
}

export function isPgSearchAliasMissingError(error: unknown): boolean {
	return errorMessage(error).includes("is not part of the pg_search index");
}

export function isPgSearchUnsupportedError(error: unknown): boolean {
	const code =
		typeof error === "object" && error !== null
			? (error as { code?: unknown }).code
			: undefined;
	if (code === "3F000" || code === "42883" || code === "42704") {
		return true;
	}

	const message = errorMessage(error);
	return (
		message.includes('schema "pdb" does not exist') ||
		message.includes('模式 "pdb" 不存在') ||
		(message.includes("operator does not exist") && message.includes("|||")) ||
		message.includes('type "pdb.') ||
		message.includes("function pdb.")
	);
}

function sortRowsForRrfRank<T extends { score: number }>(
	rows: T[],
	tieBreak: (left: T, right: T) => number,
): T[] {
	return [...rows].sort(
		(left, right) => right.score - left.score || tieBreak(left, right),
	);
}

function mergeRankedRows<
	T extends { source_ref: string; content: string; score: number },
>(
	primaryRows: T[],
	primarySignal: RetrievalSignal,
	ngramRows: T[],
	limit: number,
	tieBreak: (left: T, right: T) => number,
): Array<T & { score: number }> {
	const rankedPrimaryRows = sortRowsForRrfRank(primaryRows, tieBreak);
	const rankedNgramRows = sortRowsForRrfRank(ngramRows, tieBreak);
	const rowBySourceRef = new Map<string, T>();
	const candidates: SignalCandidate[] = [];

	for (const [rank, row] of rankedPrimaryRows.entries()) {
		rowBySourceRef.set(row.source_ref, row);
		candidates.push({
			sourceRef: row.source_ref,
			signal: primarySignal,
			rank,
			content: row.content,
		});
	}

	for (const [rank, row] of rankedNgramRows.entries()) {
		if (!rowBySourceRef.has(row.source_ref)) {
			rowBySourceRef.set(row.source_ref, row);
		}
		candidates.push({
			sourceRef: row.source_ref,
			signal: "bm25_ngram",
			rank,
			content: row.content,
		});
	}

	const merged = mergeSignalCandidates(candidates);
	return merged
		.map((entry) => {
			const row = rowBySourceRef.get(entry.sourceRef);
			if (!row) {
				return null;
			}
			return {
				...row,
				score: entry.score,
			};
		})
		.filter((row): row is T & { score: number } => row !== null)
		.sort((left, right) => right.score - left.score || tieBreak(left, right))
		.slice(0, Math.max(1, limit));
}

export function buildCognitionWordSql(
	options: BuildCognitionWordSqlOptions,
): BuiltPgSearchSql {
	const useAliasSyntax = options.useAliasSyntax !== false;
	const params: SqlParam[] = [options.agentId, options.query];
	const conditions: string[] = ["agent_id = $1"];

	const wordField = options.useJieba
		? "content_search_text"
		: useAliasSyntax
			? "content_search_text::pdb.alias('content_en')"
			: "content_search_text";
	const queryCast = options.useJieba ? "::pdb.jieba" : "::pdb.unicode_words";
	conditions.push(`${wordField} ||| $2${queryCast}`);

	let nextParam = 3;
	if (options.kind) {
		conditions.push(`kind = $${nextParam}`);
		params.push(options.kind);
		nextParam += 1;
	}
	if (options.stance) {
		conditions.push(`stance = $${nextParam}`);
		params.push(options.stance);
		nextParam += 1;
	}
	if (options.basis) {
		conditions.push(`basis = $${nextParam}`);
		params.push(options.basis);
		nextParam += 1;
	}
	if (options.activeOnly) {
		conditions.push(
			"(stance IS NULL OR stance NOT IN ('rejected', 'abandoned'))",
		);
	}
	if (isFiniteNumber(options.asOfCommittedTime)) {
		conditions.push(`updated_at <= $${nextParam}`);
		params.push(options.asOfCommittedTime);
		nextParam += 1;
	}
	if (isFiniteNumber(options.minScore)) {
		conditions.push(`pdb.score(id) >= $${nextParam}`);
		params.push(options.minScore);
		nextParam += 1;
	}

	params.push(Math.max(1, options.limit));

	return {
		text: `SELECT source_ref,
                  kind,
                  basis,
                  stance,
                  content,
                  updated_at,
                  pdb.score(id) AS score
           FROM search_docs_cognition
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC
           LIMIT $${nextParam}`,
		params,
	};
}

export function buildCognitionNgramSql(
	options: BuildCognitionNgramSqlOptions,
): BuiltPgSearchSql {
	const useAliasSyntax = options.useAliasSyntax !== false;
	const params: SqlParam[] = [options.agentId, options.query];
	const conditions: string[] = ["agent_id = $1"];
	const ngramField = useAliasSyntax
		? "content_ngram_text::pdb.alias('content_ngram')"
		: "content_ngram_text";
	conditions.push(`${ngramField} ||| $2`);

	let nextParam = 3;
	if (options.kind) {
		conditions.push(`kind = $${nextParam}`);
		params.push(options.kind);
		nextParam += 1;
	}
	if (options.stance) {
		conditions.push(`stance = $${nextParam}`);
		params.push(options.stance);
		nextParam += 1;
	}
	if (options.basis) {
		conditions.push(`basis = $${nextParam}`);
		params.push(options.basis);
		nextParam += 1;
	}
	if (options.activeOnly) {
		conditions.push(
			"(stance IS NULL OR stance NOT IN ('rejected', 'abandoned'))",
		);
	}
	if (isFiniteNumber(options.asOfCommittedTime)) {
		conditions.push(`updated_at <= $${nextParam}`);
		params.push(options.asOfCommittedTime);
		nextParam += 1;
	}
	if (isFiniteNumber(options.minScore)) {
		conditions.push(`pdb.score(id) >= $${nextParam}`);
		params.push(options.minScore);
		nextParam += 1;
	}

	params.push(Math.max(1, options.limit));

	return {
		text: `SELECT source_ref,
                  kind,
                  basis,
                  stance,
                  content,
                  updated_at,
                  pdb.score(id) AS score
           FROM search_docs_cognition
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC
           LIMIT $${nextParam}`,
		params,
	};
}

export function buildEpisodeWordSql(
	options: BuildEpisodeWordSqlOptions,
): BuiltPgSearchSql {
	const useAliasSyntax = options.useAliasSyntax !== false;
	const params: SqlParam[] = [options.agentId, options.query];
	const conditions: string[] = ["agent_id = $1"];

	const wordField = options.useJieba
		? "content_search_text"
		: useAliasSyntax
			? "content_search_text::pdb.alias('content_en')"
			: "content_search_text";
	const queryCast = options.useJieba ? "::pdb.jieba" : "::pdb.unicode_words";
	conditions.push(`${wordField} ||| $2${queryCast}`);

	let nextParam = 3;
	if (options.category) {
		conditions.push(`category = $${nextParam}`);
		params.push(options.category);
		nextParam += 1;
	}
	if (isFiniteNumber(options.asOfCommittedTime)) {
		conditions.push(`committed_at <= $${nextParam}`);
		params.push(options.asOfCommittedTime);
		nextParam += 1;
	}
	if (isFiniteNumber(options.minScore)) {
		conditions.push(`pdb.score(id) >= $${nextParam}`);
		params.push(options.minScore);
		nextParam += 1;
	}

	params.push(Math.max(1, options.limit));

	return {
		text: `SELECT id,
                  source_ref,
                  agent_id,
                  doc_type,
                  category,
                  content,
                  committed_at,
                  created_at,
                  actor,
                  pdb.score(id) AS score
           FROM search_docs_episode
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC
           LIMIT $${nextParam}`,
		params,
	};
}

export function buildEpisodeNgramSql(
	options: BuildEpisodeNgramSqlOptions,
): BuiltPgSearchSql {
	const useAliasSyntax = options.useAliasSyntax !== false;
	const params: SqlParam[] = [options.agentId, options.query];
	const conditions: string[] = ["agent_id = $1"];
	const ngramField = useAliasSyntax
		? "content_ngram_text::pdb.alias('content_ngram')"
		: "content_ngram_text";
	conditions.push(`${ngramField} ||| $2`);

	let nextParam = 3;
	if (options.category) {
		conditions.push(`category = $${nextParam}`);
		params.push(options.category);
		nextParam += 1;
	}
	if (isFiniteNumber(options.asOfCommittedTime)) {
		conditions.push(`committed_at <= $${nextParam}`);
		params.push(options.asOfCommittedTime);
		nextParam += 1;
	}
	if (isFiniteNumber(options.minScore)) {
		conditions.push(`pdb.score(id) >= $${nextParam}`);
		params.push(options.minScore);
		nextParam += 1;
	}

	params.push(Math.max(1, options.limit));

	return {
		text: `SELECT id,
                  source_ref,
                  agent_id,
                  doc_type,
                  category,
                  content,
                  committed_at,
                  created_at,
                  actor,
                  pdb.score(id) AS score
           FROM search_docs_episode
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC
           LIMIT $${nextParam}`,
		params,
	};
}

export function buildAreaWordSql(
	options: BuildAreaWordSqlOptions,
): BuiltPgSearchSql {
	const useAliasSyntax = options.useAliasSyntax !== false;
	const params: SqlParam[] = [options.locationEntityId, options.query];
	const conditions: string[] = ["location_entity_id = $1"];

	const wordField = options.useJieba
		? "content_search_text"
		: useAliasSyntax
			? "content_search_text::pdb.alias('content_en')"
			: "content_search_text";
	const queryCast = options.useJieba ? "::pdb.jieba" : "::pdb.unicode_words";
	conditions.push(`${wordField} ||| $2${queryCast}`);

	let nextParam = 3;
	if (options.entityIds && options.entityIds.length > 0) {
		conditions.push(`location_entity_id = ANY($${nextParam}::bigint[])`);
		params.push(options.entityIds);
		nextParam += 1;
	}
	if (isFiniteNumber(options.asOfCreatedTime)) {
		conditions.push(`created_at <= $${nextParam}`);
		params.push(options.asOfCreatedTime);
		nextParam += 1;
	}
	if (isFiniteNumber(options.minScore)) {
		conditions.push(`pdb.score(id) >= $${nextParam}`);
		params.push(options.minScore);
		nextParam += 1;
	}

	params.push(Math.max(1, options.limit));

	return {
		text: `SELECT id,
                  source_ref,
                  location_entity_id,
                  doc_type,
                  content,
                  created_at,
                  pdb.score(id) AS score
           FROM search_docs_area
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC
           LIMIT $${nextParam}`,
		params,
	};
}

export function buildAreaNgramSql(
	options: BuildAreaNgramSqlOptions,
): BuiltPgSearchSql {
	const useAliasSyntax = options.useAliasSyntax !== false;
	const params: SqlParam[] = [options.locationEntityId, options.query];
	const conditions: string[] = ["location_entity_id = $1"];
	const ngramField = useAliasSyntax
		? "content_ngram_text::pdb.alias('content_ngram')"
		: "content_ngram_text";
	conditions.push(`${ngramField} ||| $2`);

	let nextParam = 3;
	if (options.entityIds && options.entityIds.length > 0) {
		conditions.push(`location_entity_id = ANY($${nextParam}::bigint[])`);
		params.push(options.entityIds);
		nextParam += 1;
	}
	if (isFiniteNumber(options.asOfCreatedTime)) {
		conditions.push(`created_at <= $${nextParam}`);
		params.push(options.asOfCreatedTime);
		nextParam += 1;
	}
	if (isFiniteNumber(options.minScore)) {
		conditions.push(`pdb.score(id) >= $${nextParam}`);
		params.push(options.minScore);
		nextParam += 1;
	}

	params.push(Math.max(1, options.limit));

	return {
		text: `SELECT id,
                  source_ref,
                  location_entity_id,
                  doc_type,
                  content,
                  created_at,
                  pdb.score(id) AS score
           FROM search_docs_area
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC
           LIMIT $${nextParam}`,
		params,
	};
}

export function buildWorldWordSql(
	options: BuildWorldWordSqlOptions,
): BuiltPgSearchSql {
	const useAliasSyntax = options.useAliasSyntax !== false;
	const params: SqlParam[] = [options.query];

	const wordField = options.useJieba
		? "content_search_text"
		: useAliasSyntax
			? "content_search_text::pdb.alias('content_en')"
			: "content_search_text";
	const queryCast = options.useJieba ? "::pdb.jieba" : "::pdb.unicode_words";
	const conditions: string[] = [`${wordField} ||| $1${queryCast}`];

	let nextParam = 2;
	if (isFiniteNumber(options.asOfCreatedTime)) {
		conditions.push(`created_at <= $${nextParam}`);
		params.push(options.asOfCreatedTime);
		nextParam += 1;
	}
	if (isFiniteNumber(options.minScore)) {
		conditions.push(`pdb.score(id) >= $${nextParam}`);
		params.push(options.minScore);
		nextParam += 1;
	}

	params.push(Math.max(1, options.limit));

	return {
		text: `SELECT id,
                  source_ref,
                  doc_type,
                  content,
                  created_at,
                  pdb.score(id) AS score
           FROM search_docs_world
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC
           LIMIT $${nextParam}`,
		params,
	};
}

export function buildWorldNgramSql(
	options: BuildWorldNgramSqlOptions,
): BuiltPgSearchSql {
	const useAliasSyntax = options.useAliasSyntax !== false;
	const params: SqlParam[] = [options.query];
	const ngramField = useAliasSyntax
		? "content_ngram_text::pdb.alias('content_ngram')"
		: "content_ngram_text";
	const conditions: string[] = [`${ngramField} ||| $1`];

	let nextParam = 2;
	if (isFiniteNumber(options.asOfCreatedTime)) {
		conditions.push(`created_at <= $${nextParam}`);
		params.push(options.asOfCreatedTime);
		nextParam += 1;
	}
	if (isFiniteNumber(options.minScore)) {
		conditions.push(`pdb.score(id) >= $${nextParam}`);
		params.push(options.minScore);
		nextParam += 1;
	}

	params.push(Math.max(1, options.limit));

	return {
		text: `SELECT id,
                  source_ref,
                  doc_type,
                  content,
                  created_at,
                  pdb.score(id) AS score
           FROM search_docs_world
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC
           LIMIT $${nextParam}`,
		params,
	};
}

export class PgSearchLexicalBackend {
	constructor(private readonly sql: postgres.Sql) {}

	async searchCognition(
		query: PgSearchCognitionQuery,
	): Promise<CognitionSearchPgRow[]> {
		const trimmed = query.query.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const limit = Math.max(1, query.limit ?? 100);
		const useJieba = containsCjk(trimmed);
		const primarySql = buildCognitionWordSql({
			query: trimmed,
			agentId: query.agentId,
			limit,
			useJieba,
			kind: query.kind,
			stance: query.stance,
			basis: query.basis,
			activeOnly: query.activeOnly,
			asOfCommittedTime: query.asOfCommittedTime,
			minScore: query.minScore,
		});
		const primaryRows = await this.queryCognition(
			primarySql,
			!useJieba
				? () =>
						buildCognitionWordSql({
							query: trimmed,
							agentId: query.agentId,
							limit,
							useJieba,
							useAliasSyntax: false,
							kind: query.kind,
							stance: query.stance,
							basis: query.basis,
							activeOnly: query.activeOnly,
							asOfCommittedTime: query.asOfCommittedTime,
							minScore: query.minScore,
						})
				: undefined,
		);

		const route = decidePgSearchRouting(trimmed, primaryRows.length, limit);
		const ngramRows = route.shouldRunNgram
			? await this.queryCognition(
					buildCognitionNgramSql({
						query: trimmed,
						agentId: query.agentId,
						limit: route.ngramLimit,
						kind: query.kind,
						stance: query.stance,
						basis: query.basis,
						activeOnly: query.activeOnly,
						asOfCommittedTime: query.asOfCommittedTime,
						minScore: query.minScore,
					}),
					() =>
						buildCognitionNgramSql({
							query: trimmed,
							agentId: query.agentId,
							limit: route.ngramLimit,
							useAliasSyntax: false,
							kind: query.kind,
							stance: query.stance,
							basis: query.basis,
							activeOnly: query.activeOnly,
							asOfCommittedTime: query.asOfCommittedTime,
							minScore: query.minScore,
						}),
				)
			: [];

		const primarySignal: RetrievalSignal = useJieba ? "bm25_jieba" : "bm25_en";
		return mergeRankedRows(
			primaryRows,
			primarySignal,
			ngramRows,
			limit,
			(left, right) => toNumber(right.updated_at) - toNumber(left.updated_at),
		);
	}

	async searchEpisode(
		query: PgSearchEpisodeQuery,
	): Promise<EpisodeSearchPgRow[]> {
		const trimmed = query.query.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const limit = Math.max(1, query.limit ?? 20);
		const useJieba = containsCjk(trimmed);
		const primarySql = buildEpisodeWordSql({
			query: trimmed,
			agentId: query.agentId,
			limit,
			useJieba,
			category: query.category,
			asOfCommittedTime: query.asOfCommittedTime,
			minScore: query.minScore,
		});
		const primaryRows = await this.queryEpisode(
			primarySql,
			!useJieba
				? () =>
						buildEpisodeWordSql({
							query: trimmed,
							agentId: query.agentId,
							limit,
							useJieba,
							useAliasSyntax: false,
							category: query.category,
							asOfCommittedTime: query.asOfCommittedTime,
							minScore: query.minScore,
						})
				: undefined,
		);

		const route = decidePgSearchRouting(trimmed, primaryRows.length, limit);
		const ngramRows = route.shouldRunNgram
			? await this.queryEpisode(
					buildEpisodeNgramSql({
						query: trimmed,
						agentId: query.agentId,
						limit: route.ngramLimit,
						category: query.category,
						asOfCommittedTime: query.asOfCommittedTime,
						minScore: query.minScore,
					}),
					() =>
						buildEpisodeNgramSql({
							query: trimmed,
							agentId: query.agentId,
							limit: route.ngramLimit,
							useAliasSyntax: false,
							category: query.category,
							asOfCommittedTime: query.asOfCommittedTime,
							minScore: query.minScore,
						}),
				)
			: [];

		const primarySignal: RetrievalSignal = useJieba ? "bm25_jieba" : "bm25_en";
		return mergeRankedRows(
			primaryRows,
			primarySignal,
			ngramRows,
			limit,
			(left, right) =>
				toNumber(right.committed_at) - toNumber(left.committed_at),
		);
	}

	async searchArea(query: PgSearchAreaQuery): Promise<AreaSearchPgRow[]> {
		const trimmed = query.query.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const limit = Math.max(1, query.limit ?? 20);
		const useJieba = containsCjk(trimmed);
		const primarySql = buildAreaWordSql({
			query: trimmed,
			locationEntityId: query.locationEntityId,
			limit,
			useJieba,
			entityIds: query.entityIds,
			asOfCreatedTime: query.asOfCreatedTime,
			minScore: query.minScore,
		});
		const primaryRows = await this.queryArea(
			primarySql,
			!useJieba
				? () =>
						buildAreaWordSql({
							query: trimmed,
							locationEntityId: query.locationEntityId,
							limit,
							useJieba,
							useAliasSyntax: false,
							entityIds: query.entityIds,
							asOfCreatedTime: query.asOfCreatedTime,
							minScore: query.minScore,
						})
				: undefined,
		);

		const route = decidePgSearchRouting(trimmed, primaryRows.length, limit);
		const ngramRows = route.shouldRunNgram
			? await this.queryArea(
					buildAreaNgramSql({
						query: trimmed,
						locationEntityId: query.locationEntityId,
						limit: route.ngramLimit,
						entityIds: query.entityIds,
						asOfCreatedTime: query.asOfCreatedTime,
						minScore: query.minScore,
					}),
					() =>
						buildAreaNgramSql({
							query: trimmed,
							locationEntityId: query.locationEntityId,
							limit: route.ngramLimit,
							useAliasSyntax: false,
							entityIds: query.entityIds,
							asOfCreatedTime: query.asOfCreatedTime,
							minScore: query.minScore,
						}),
				)
			: [];

		const primarySignal: RetrievalSignal = useJieba ? "bm25_jieba" : "bm25_en";
		return mergeRankedRows(
			primaryRows,
			primarySignal,
			ngramRows,
			limit,
			(left, right) => toNumber(right.created_at) - toNumber(left.created_at),
		);
	}

	async searchWorld(query: PgSearchWorldQuery): Promise<WorldSearchPgRow[]> {
		const trimmed = query.query.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const limit = Math.max(1, query.limit ?? 20);
		const useJieba = containsCjk(trimmed);
		const primarySql = buildWorldWordSql({
			query: trimmed,
			limit,
			useJieba,
			asOfCreatedTime: query.asOfCreatedTime,
			minScore: query.minScore,
		});
		const primaryRows = await this.queryWorld(
			primarySql,
			!useJieba
				? () =>
						buildWorldWordSql({
							query: trimmed,
							limit,
							useJieba,
							useAliasSyntax: false,
							asOfCreatedTime: query.asOfCreatedTime,
							minScore: query.minScore,
						})
				: undefined,
		);

		const route = decidePgSearchRouting(trimmed, primaryRows.length, limit);
		const ngramRows = route.shouldRunNgram
			? await this.queryWorld(
					buildWorldNgramSql({
						query: trimmed,
						limit: route.ngramLimit,
						asOfCreatedTime: query.asOfCreatedTime,
						minScore: query.minScore,
					}),
					() =>
						buildWorldNgramSql({
							query: trimmed,
							limit: route.ngramLimit,
							useAliasSyntax: false,
							asOfCreatedTime: query.asOfCreatedTime,
							minScore: query.minScore,
						}),
				)
			: [];

		const primarySignal: RetrievalSignal = useJieba ? "bm25_jieba" : "bm25_en";
		return mergeRankedRows(
			primaryRows,
			primarySignal,
			ngramRows,
			limit,
			(left, right) => toNumber(right.created_at) - toNumber(left.created_at),
		);
	}

	private async queryCognition(
		builtSql: BuiltPgSearchSql,
		aliasFallback?: () => BuiltPgSearchSql,
	): Promise<CognitionSearchPgRow[]> {
		const rows = await this.queryWithAliasFallback<CognitionQueryRawRow>(
			builtSql,
			aliasFallback,
		);
		return rows.map((row) => ({
			...row,
			score: toNumber(row.score),
		}));
	}

	private async queryEpisode(
		builtSql: BuiltPgSearchSql,
		aliasFallback?: () => BuiltPgSearchSql,
	): Promise<EpisodeSearchPgRow[]> {
		const rows = await this.queryWithAliasFallback<EpisodeQueryRawRow>(
			builtSql,
			aliasFallback,
		);
		return rows.map((row) => ({
			...row,
			score: toNumber(row.score),
		}));
	}

	private async queryArea(
		builtSql: BuiltPgSearchSql,
		aliasFallback?: () => BuiltPgSearchSql,
	): Promise<AreaSearchPgRow[]> {
		const rows = await this.queryWithAliasFallback<AreaQueryRawRow>(
			builtSql,
			aliasFallback,
		);
		return rows.map((row) => ({
			...row,
			location_entity_id: toNumber(row.location_entity_id),
			score: toNumber(row.score),
		}));
	}

	private async queryWorld(
		builtSql: BuiltPgSearchSql,
		aliasFallback?: () => BuiltPgSearchSql,
	): Promise<WorldSearchPgRow[]> {
		const rows = await this.queryWithAliasFallback<WorldQueryRawRow>(
			builtSql,
			aliasFallback,
		);
		return rows.map((row) => ({
			...row,
			score: toNumber(row.score),
		}));
	}

	private async queryWithAliasFallback<T>(
		builtSql: BuiltPgSearchSql,
		aliasFallback?: () => BuiltPgSearchSql,
	): Promise<T[]> {
		try {
			return (await this.sql.unsafe(builtSql.text, builtSql.params)) as T[];
		} catch (error) {
			if (!aliasFallback || !isPgSearchAliasMissingError(error)) {
				throw error;
			}
			const fallbackSql = aliasFallback();
			return (await this.sql.unsafe(
				fallbackSql.text,
				fallbackSql.params,
			)) as T[];
		}
	}
}
