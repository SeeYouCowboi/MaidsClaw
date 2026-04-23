import type postgres from "postgres";
import type { ViewerContext } from "../../../memory/types.js";
import type {
	NarrativeSearchHit,
	NarrativeSearchQuery,
	NarrativeSearchRepo,
} from "../contracts/narrative-search-repo.js";
import {
	PgSearchLexicalBackend,
} from "./pg-search-backend.js";

type PgNarrativeSearchRow = {
	source_ref: string;
	doc_type: string;
	content: string;
	score: number | string;
};

const DEFAULT_LIMIT = 20;
const DEFAULT_MIN_SCORE = 0.2;

function toNumber(value: number | string): number {
	return typeof value === "number" ? value : Number(value);
}

export class PgNarrativeSearchRepo implements NarrativeSearchRepo {
	private readonly lexicalBackend: Pick<
		PgSearchLexicalBackend,
		"searchArea" | "searchWorld" | "searchEpisode"
	>;

	constructor(
		sql: postgres.Sql,
		lexicalBackend?: Pick<
			PgSearchLexicalBackend,
			"searchArea" | "searchWorld" | "searchEpisode"
		>,
	) {
		this.lexicalBackend = lexicalBackend ?? new PgSearchLexicalBackend(sql);
	}

	async searchNarrative(
		query: NarrativeSearchQuery,
		viewerContext: ViewerContext,
	): Promise<NarrativeSearchHit[]> {
		const trimmed = query.text.trim();
		if (trimmed.length < 2) {
			return [];
		}

		const includeArea = query.includeArea ?? true;
		const includeWorld = query.includeWorld ?? true;
		const includeEpisode = query.includeEpisode ?? false;
		if (!includeArea && !includeWorld && !includeEpisode) {
			return [];
		}

		const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT);
		const minScore = query.minScore ?? DEFAULT_MIN_SCORE;

		// GAP-4 §1: only honor non-empty entity id lists. Empty == no filter.
		const entityIds =
			query.entityIds && query.entityIds.length > 0
				? query.entityIds
				: undefined;
		const asOfCommittedTime = query.timeWindow?.asOfCommittedTime;

		return this.searchWithPgSearch(
			trimmed,
			viewerContext,
			includeArea,
			includeWorld,
			includeEpisode,
			limit,
			minScore,
			entityIds,
			asOfCommittedTime,
		);
	}

	private async searchWithPgSearch(
		trimmed: string,
		viewerContext: ViewerContext,
		includeArea: boolean,
		includeWorld: boolean,
		includeEpisode: boolean,
		limit: number,
		minScore: number,
		entityIds: number[] | undefined,
		asOfCommittedTime: number | undefined,
	): Promise<NarrativeSearchHit[]> {
		const results: NarrativeSearchHit[] = [];

		if (includeArea && viewerContext.current_area_id != null) {
			const areaRows = await this.lexicalBackend.searchArea({
				query: trimmed,
				locationEntityId: viewerContext.current_area_id,
				limit,
				minScore,
				entityIds,
				asOfCreatedTime: asOfCommittedTime,
			});
			results.push(
				...areaRows.map((row) =>
					this.mapRow(
						{
							source_ref: row.source_ref,
							doc_type: row.doc_type,
							content: row.content,
							score: row.score,
						},
						"area",
					),
				),
			);
		}

		if (includeWorld) {
			const worldRows = await this.lexicalBackend.searchWorld({
				query: trimmed,
				limit,
				minScore,
				asOfCreatedTime: asOfCommittedTime,
			});
			results.push(
				...worldRows.map((row) =>
					this.mapRow(
						{
							source_ref: row.source_ref,
							doc_type: row.doc_type,
							content: row.content,
							score: row.score,
						},
						"world",
					),
				),
			);
		}

		if (includeEpisode) {
			const episodeRows = await this.lexicalBackend.searchEpisode({
				query: trimmed,
				agentId: viewerContext.viewer_agent_id,
				limit,
				minScore,
				asOfCommittedTime,
			});
			results.push(
				...episodeRows.map((row) =>
					this.mapRow(
						{
							source_ref: row.source_ref,
							doc_type: row.doc_type,
							content: row.content,
							score: row.score,
						},
						"episode",
					),
				),
			);
		}

		// pg_search path already applies min-score at SQL level (pdb.score).
		// Candidate scores are weighted RRF values and intentionally not on the
		// same numeric scale as pg_trgm similarity, so we avoid re-filtering here.
		return this.dedup(results, limit, 0);
	}

	private dedup(
		results: NarrativeSearchHit[],
		limit: number,
		minScore: number,
	): NarrativeSearchHit[] {
		const deduped = new Map<string, NarrativeSearchHit>();
		for (const result of results) {
			if (result.score < minScore) {
				continue;
			}
			const key = `${result.sourceRef}|${result.docType}`;
			const existing = deduped.get(key);
			if (!existing || result.score > existing.score) {
				deduped.set(key, result);
			}
		}

		return Array.from(deduped.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	private mapRow(
		row: PgNarrativeSearchRow,
		scope: "area" | "world" | "episode",
	): NarrativeSearchHit {
		return {
			sourceRef: row.source_ref as NarrativeSearchHit["sourceRef"],
			docType: row.doc_type,
			content: row.content,
			scope,
			score: toNumber(row.score),
		};
	}
}
