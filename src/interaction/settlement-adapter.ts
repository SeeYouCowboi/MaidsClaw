import type {
	PrivateCognitionCommit,
	PrivateCognitionCommitV4,
	PublicationDeclaration,
} from "../runtime/rp-turn-contract.js";
import type { TurnSettlementPayload } from "./contracts.js";

export type NormalizedSettlementPayload = {
	settlementId: string;
	requestId: string;
	sessionId: string;
	ownerAgentId: string;
	publicReply: string;
	hasPublicReply: boolean;
	viewerSnapshot: TurnSettlementPayload["viewerSnapshot"];
	schemaVersion: "turn_settlement_v4";
	privateCommit?: PrivateCognitionCommitV4;
	publications: PublicationDeclaration[];
};

export function detectSettlementVersion(
	payload: TurnSettlementPayload,
): "v3" | "v4" {
	return payload.schemaVersion === "turn_settlement_v4" ? "v4" : "v3";
}

export function normalizeSettlementPayload(
	payload: TurnSettlementPayload,
): NormalizedSettlementPayload {
	const privateCommit = normalizePrivateCommit(payload.privateCommit);

	return {
		settlementId: payload.settlementId,
		requestId: payload.requestId,
		sessionId: payload.sessionId,
		ownerAgentId: payload.ownerAgentId,
		publicReply: payload.publicReply,
		hasPublicReply: payload.hasPublicReply,
		viewerSnapshot: payload.viewerSnapshot,
		schemaVersion: "turn_settlement_v4",
		...(privateCommit ? { privateCommit } : {}),
		publications: Array.isArray(payload.publications)
			? payload.publications
			: [],
	};
}

function normalizePrivateCommit(
	privateCommit: PrivateCognitionCommit | PrivateCognitionCommitV4 | undefined,
): PrivateCognitionCommitV4 | undefined {
	if (!privateCommit) {
		return undefined;
	}

	if (privateCommit.schemaVersion === "rp_private_cognition_v4") {
		return privateCommit;
	}

	return {
		schemaVersion: "rp_private_cognition_v4",
		...(typeof privateCommit.summary === "string"
			? { summary: privateCommit.summary }
			: {}),
		ops: privateCommit.ops,
	};
}
