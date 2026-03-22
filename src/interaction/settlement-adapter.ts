import type {
	ConflictFactor,
	PinnedSummaryProposal,
	PrivateCognitionCommit,
	PrivateCognitionCommitV4,
	PrivateEpisodeArtifact,
	PublicationDeclaration,
	RelationIntent,
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
	schemaVersion: "turn_settlement_v5";
	privateCognition?: PrivateCognitionCommitV4;
	privateEpisodes: PrivateEpisodeArtifact[];
	publications: PublicationDeclaration[];
	pinnedSummaryProposal?: PinnedSummaryProposal;
	relationIntents: RelationIntent[];
	conflictFactors: ConflictFactor[];
};

export function detectSettlementVersion(
	payload: TurnSettlementPayload,
): "v3" | "v4" | "v5" {
	if (payload.schemaVersion === "turn_settlement_v5") return "v5";
	if (payload.schemaVersion === "turn_settlement_v4") return "v4";
	return "v3";
}

export function normalizeSettlementPayload(
	payload: TurnSettlementPayload,
): NormalizedSettlementPayload {
	const privateCognition = resolvePrivateCognition(payload);

	return {
		settlementId: payload.settlementId,
		requestId: payload.requestId,
		sessionId: payload.sessionId,
		ownerAgentId: payload.ownerAgentId,
		publicReply: payload.publicReply,
		hasPublicReply: payload.hasPublicReply,
		viewerSnapshot: payload.viewerSnapshot,
		schemaVersion: "turn_settlement_v5",
		...(privateCognition ? { privateCognition } : {}),
		privateEpisodes: Array.isArray(payload.privateEpisodes)
			? payload.privateEpisodes
			: [],
		publications: Array.isArray(payload.publications)
			? payload.publications
			: [],
		...(payload.pinnedSummaryProposal ? { pinnedSummaryProposal: payload.pinnedSummaryProposal } : {}),
		relationIntents: Array.isArray(payload.relationIntents)
			? payload.relationIntents
			: [],
		conflictFactors: Array.isArray(payload.conflictFactors)
			? payload.conflictFactors
			: [],
	};
}

function resolvePrivateCognition(
	payload: TurnSettlementPayload,
): PrivateCognitionCommitV4 | undefined {
	if (payload.privateCognition) {
		return payload.privateCognition;
	}
	return normalizePrivateCommitCompat(payload.privateCommit);
}

function normalizePrivateCommitCompat(
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
