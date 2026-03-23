import type { EvidencePath, NodeRef } from "./types.js";

export type TimeSliceQuery = {
  asOfValidTime?: number;
  asOfCommittedTime?: number;
};

export type TimeSlicedPathSummary = {
  seed: NodeRef;
  depth: number;
  edge_count: number;
  omitted_edges: number;
  has_valid_cut: boolean;
  has_committed_cut: boolean;
};

type TimeAwareEdge = {
  timestamp?: number | null;
  valid_time?: number | null;
  committed_time?: number | null;
};

export function hasTimeSlice(query?: TimeSliceQuery): boolean {
  return query?.asOfValidTime != null || query?.asOfCommittedTime != null;
}

export function isEdgeInTimeSlice(edge: TimeAwareEdge, query?: TimeSliceQuery): boolean {
  if (!hasTimeSlice(query)) {
    return true;
  }
  const effectiveValid = edge.valid_time ?? edge.timestamp ?? null;
  const effectiveCommitted = edge.committed_time ?? edge.timestamp ?? null;

  if (query?.asOfValidTime != null && effectiveValid != null && effectiveValid > query.asOfValidTime) {
    return false;
  }
  if (query?.asOfCommittedTime != null && effectiveCommitted != null && effectiveCommitted > query.asOfCommittedTime) {
    return false;
  }
  return true;
}

export function filterEvidencePathsByTimeSlice(paths: EvidencePath[], query?: TimeSliceQuery): EvidencePath[] {
  if (!hasTimeSlice(query)) {
    return paths;
  }

  const filtered: EvidencePath[] = [];
  for (const path of paths) {
    const keptEdges = path.path.edges.filter((edge) => isEdgeInTimeSlice(edge, query));
    if (keptEdges.length === 0 && path.path.edges.length > 0) {
      continue;
    }

    const visited = new Set<NodeRef>([path.path.seed]);
    for (const edge of keptEdges) {
      visited.add(edge.from);
      visited.add(edge.to);
    }

    const orderedNodes = path.path.nodes.filter((node) => visited.has(node));
    if (orderedNodes.length === 0) {
      continue;
    }

    filtered.push({
      ...path,
      path: {
        ...path.path,
        seed: orderedNodes[0],
        nodes: orderedNodes,
        edges: keptEdges,
        depth: Math.min(path.path.depth, keptEdges.length),
      },
      supporting_nodes: path.supporting_nodes.filter((node) => visited.has(node)),
    });
  }

  return filtered;
}

export function summarizeTimeSlicedPaths(paths: EvidencePath[], query?: TimeSliceQuery): TimeSlicedPathSummary[] {
  return paths.map((path) => {
    const keptCount = path.path.edges.filter((edge) => isEdgeInTimeSlice(edge, query)).length;
    return {
      seed: path.path.seed,
      depth: path.path.depth,
      edge_count: path.path.edges.length,
      omitted_edges: Math.max(0, path.path.edges.length - keptCount),
      has_valid_cut: query?.asOfValidTime != null,
      has_committed_cut: query?.asOfCommittedTime != null,
    };
  });
}
