import {
	handleAgentMemoryEpisodes,
	handleAgentMemoryNarratives,
	handleAgentMemorySettlements,
	handleGetCoreMemoryBlock,
	handleListCoreMemoryBlocks,
	handleListPinnedSummaries,
} from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const MEMORY_ROUTES: RouteEntry[] = [
	{
		method: "GET",
		pattern: "/v1/agents/{agent_id}/memory/episodes",
		handler: handleAgentMemoryEpisodes,
	},
	{
		method: "GET",
		pattern: "/v1/agents/{agent_id}/memory/narratives",
		handler: handleAgentMemoryNarratives,
	},
	{
		method: "GET",
		pattern: "/v1/agents/{agent_id}/memory/settlements",
		handler: handleAgentMemorySettlements,
	},
	{
		method: "GET",
		pattern: "/v1/agents/{agent_id}/memory/core-blocks",
		handler: handleListCoreMemoryBlocks,
	},
	{
		method: "GET",
		pattern: "/v1/agents/{agent_id}/memory/core-blocks/{label}",
		handler: handleGetCoreMemoryBlock,
	},
	{
		method: "GET",
		pattern: "/v1/agents/{agent_id}/memory/pinned-summaries",
		handler: handleListPinnedSummaries,
	},
];
