import {
	type RetrievalSignal,
	RRF_K,
	SIGNAL_WEIGHTS,
	type SignalCandidate,
} from "./search-backend-contract.js";

export interface MergedCandidate {
	sourceRef: string;
	score: number;
	signals: RetrievalSignal[];
	content?: string;
}

export function mergeSignalCandidates(
	candidates: SignalCandidate[],
): MergedCandidate[] {
	const merged = new Map<
		string,
		{
			sourceRef: string;
			score: number;
			signalSet: Set<RetrievalSignal>;
			content?: string;
		}
	>();

	for (const candidate of candidates) {
		const { sourceRef, signal } = candidate;
		const weight = SIGNAL_WEIGHTS[signal];
		const rank = Number.isFinite(candidate.rank)
			? Math.max(0, Math.floor(candidate.rank))
			: 0;
		const scoreContribution = weight * (1 / (RRF_K + rank + 1));

		const current = merged.get(sourceRef) ?? {
			sourceRef,
			score: 0,
			signalSet: new Set<RetrievalSignal>(),
			content: undefined,
		};

		current.score += scoreContribution;
		current.signalSet.add(signal);
		if (!current.content && candidate.content) {
			current.content = candidate.content;
		}
		merged.set(sourceRef, current);
	}

	return Array.from(merged.values())
		.map((entry) => ({
			sourceRef: entry.sourceRef,
			score: entry.score,
			signals: Array.from(entry.signalSet),
			content: entry.content,
		}))
		.sort((a, b) => {
			if (b.score !== a.score) {
				return b.score - a.score;
			}
			if (a.sourceRef < b.sourceRef) return -1;
			if (a.sourceRef > b.sourceRef) return 1;
			return 0;
		});
}
