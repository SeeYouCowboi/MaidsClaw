// Interaction redaction utility — sanitizes sensitive fields for external/debug/export use
// IMPORTANT: This is for EXTERNAL USE ONLY. Flush ingestion must always use raw records.

import type { CognitionOp } from "../runtime/rp-turn-contract.js";
import type { InteractionRecord, TurnSettlementPayload } from "./contracts.js";
import { normalizeSettlementPayload } from "./settlement-adapter.js";

/**
 * Redacts sensitive fields from interaction records for external/debug/export use.
 *
 * For turn_settlement records:
 * - Keeps routing metadata: settlementId, requestId, sessionId, publicReply, hasPublicReply
 * - Replaces viewerSnapshot with { redacted: true }
 * - Replaces privateCommit with { redacted: true, opCount, kinds }
 *
 * For all other record types: returns unchanged.
 *
 * IMPORTANT: This function returns a NEW object and does not mutate the original.
 * Flush ingestion must ALWAYS use raw records from InteractionStore, not redacted ones.
 */
export function redactInteractionRecord(
	record: InteractionRecord,
): InteractionRecord {
	// Non-settlement records pass through unchanged (but still return a copy)
	if (record.recordType !== "turn_settlement") {
		return { ...record };
	}

	const payload = record.payload as TurnSettlementPayload;
	const normalizedPayload = normalizeSettlementPayload(payload);

	const redactedPayload = {
		settlementId: payload.settlementId,
		requestId: payload.requestId,
		sessionId: payload.sessionId,
		publicReply: payload.publicReply,
		hasPublicReply: payload.hasPublicReply,
		viewerSnapshot: { redacted: true as const },
		privateCommit: normalizedPayload.privateCognition
			? {
					redacted: true as const,
					opCount: normalizedPayload.privateCognition.ops.length,
					kinds: extractUniqueKinds(normalizedPayload.privateCognition.ops),
				}
			: undefined,
		...(normalizedPayload.privateEpisodes.length > 0
			? { privateEpisodes: { redacted: true as const, count: normalizedPayload.privateEpisodes.length } }
			: {}),
		...(normalizedPayload.pinnedSummaryProposal
			? { pinnedSummaryProposal: { redacted: true as const } }
			: {}),
	};

	return {
		...record,
		payload: redactedPayload as unknown,
	};
}

/**
 * Extracts unique operation kinds from cognition ops array.
 * Preserves order of first appearance.
 */
function extractUniqueKinds(ops: CognitionOp[]): string[] {
	const seen = new Set<string>();
	const kinds: string[] = [];

	for (const op of ops) {
		const kind = op.op === "upsert" ? op.record.kind : op.target.kind;
		if (!seen.has(kind)) {
			seen.add(kind);
			kinds.push(kind);
		}
	}

	return kinds;
}

/**
 * Redacts an array of interaction records.
 * Convenience wrapper for batch operations.
 */
export function redactInteractionRecords(
	records: InteractionRecord[],
): InteractionRecord[] {
	return records.map(redactInteractionRecord);
}
