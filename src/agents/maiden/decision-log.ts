import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeCursor, encodeCursor } from "../../contracts/cockpit/cursor.js";
import { MaidsClawError } from "../../core/errors.js";

export type MaidenDecisionEntry = {
	decision_id: string;
	request_id: string;
	session_id: string;
	delegation_depth: number;
	action: "direct_reply" | "delegate";
	target_agent_id?: string;
	chosen_from_agent_ids: string[];
	created_at: number;
};

export type MaidenDecisionListOptions = {
	sessionId?: string;
	limit?: number;
	cursor?: string;
};

export type MaidenDecisionListResult = {
	items: MaidenDecisionEntry[];
	next_cursor: string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit?: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_LIMIT;
	}
	const normalized = Math.floor(limit!);
	return Math.max(1, Math.min(MAX_LIMIT, normalized));
}

function compareDesc(a: MaidenDecisionEntry, b: MaidenDecisionEntry): number {
	if (a.created_at !== b.created_at) {
		return b.created_at - a.created_at;
	}
	return b.decision_id.localeCompare(a.decision_id);
}

function isBeforeCursor(
	entry: MaidenDecisionEntry,
	boundary?: { createdAt: number; decisionId: string },
): boolean {
	if (!boundary) {
		return true;
	}
	if (entry.created_at < boundary.createdAt) {
		return true;
	}
	if (entry.created_at > boundary.createdAt) {
		return false;
	}
	return entry.decision_id < boundary.decisionId;
}

function parseCursor(cursor?: string): { createdAt: number; decisionId: string } | undefined {
	if (!cursor) {
		return undefined;
	}
	const payload = decodeCursor(cursor);
	const createdAt = payload.sort_key;
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
		throw new MaidsClawError({
			code: "BAD_REQUEST",
			message: "Cursor sort_key must be a finite number",
			retriable: false,
		});
	}
	return {
		createdAt,
		decisionId: payload.tie_breaker,
	};
}

function parseJsonlEntry(line: string): MaidenDecisionEntry | null {
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		if (
			typeof parsed.decision_id !== "string" ||
			typeof parsed.request_id !== "string" ||
			typeof parsed.session_id !== "string" ||
			typeof parsed.delegation_depth !== "number" ||
			typeof parsed.action !== "string" ||
			typeof parsed.created_at !== "number"
		) {
			return null;
		}
		return {
			decision_id: parsed.decision_id,
			request_id: parsed.request_id,
			session_id: parsed.session_id,
			delegation_depth: parsed.delegation_depth,
			action: parsed.action as "direct_reply" | "delegate",
			target_agent_id: typeof parsed.target_agent_id === "string" ? parsed.target_agent_id : undefined,
			chosen_from_agent_ids: Array.isArray(parsed.chosen_from_agent_ids)
				? parsed.chosen_from_agent_ids.filter((id): id is string => typeof id === "string")
				: [],
			created_at: parsed.created_at,
		};
	} catch {
		return null;
	}
}

export class MaidenDecisionLog {
	private readonly entries: MaidenDecisionEntry[] = [];
	private readonly filePath: string | undefined;

	constructor(filePath?: string) {
		this.filePath = filePath;
		if (filePath && existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf8");
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (trimmed.length === 0) continue;
					const entry = parseJsonlEntry(trimmed);
					if (entry) {
						this.entries.push(entry);
					}
				}
			} catch {
				// File unreadable — start fresh
			}
		}
	}

	async append(entry: MaidenDecisionEntry): Promise<void> {
		const stored = {
			...entry,
			chosen_from_agent_ids: [...entry.chosen_from_agent_ids],
		};
		this.entries.push(stored);

		if (this.filePath) {
			try {
				mkdirSync(dirname(this.filePath), { recursive: true });
				appendFileSync(this.filePath, `${JSON.stringify(stored)}\n`, "utf8");
			} catch {
				// Append failure is non-fatal — entry is still in memory
			}
		}
	}

	async list(options: MaidenDecisionListOptions = {}): Promise<MaidenDecisionListResult> {
		const limit = clampLimit(options.limit);
		const boundary = parseCursor(options.cursor);

		const filtered = this.entries
			.filter((entry) =>
				options.sessionId ? entry.session_id === options.sessionId : true,
			)
			.sort(compareDesc)
			.filter((entry) => isBeforeCursor(entry, boundary));

		const hasMore = filtered.length > limit;
		const pageItems = hasMore ? filtered.slice(0, limit) : filtered;

		let nextCursor: string | null = null;
		if (hasMore && pageItems.length > 0) {
			const last = pageItems[pageItems.length - 1];
			nextCursor = encodeCursor({
				v: 1,
				sort_key: last.created_at,
				tie_breaker: last.decision_id,
			});
		}

		return {
			items: pageItems.map((item) => ({
				...item,
				chosen_from_agent_ids: [...item.chosen_from_agent_ids],
			})),
			next_cursor: nextCursor,
		};
	}
}
