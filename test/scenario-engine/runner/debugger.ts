type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Array<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

type GraphEntity = { id: string; type: string; [key: string]: unknown };
type GraphEdge = { from: string; to: string; type: string; [key: string]: unknown };
type IndexedDocument = { nodeRef: string; kind: string; [key: string]: unknown };
type ProbeHit = { nodeRef: string; score: number; [key: string]: unknown };

export type GraphSnapshot = DeepReadonly<{
  beatId: string;
  entities: GraphEntity[];
  edges: GraphEdge[];
}>;

export type IndexSnapshot = DeepReadonly<{
  beatId: string;
  documents: IndexedDocument[];
}>;

export type ProbeHitsSnapshot = DeepReadonly<{
  probeId: string;
  hits: ProbeHit[];
  matched: string[];
  missed: string[];
}>;

export interface ScenarioDebugger {
  getGraphState(beatId: string): GraphSnapshot;
  getIndexedContent(beatId: string): IndexSnapshot;
  getProbeHits(probeId: string): ProbeHitsSnapshot;
}

export type ScenarioDebuggerCollector = ScenarioDebugger & {
  captureGraphSnapshot(beatId: string, data: GraphSnapshotInput): GraphSnapshot;
  captureIndexSnapshot(beatId: string, data: IndexSnapshotInput): IndexSnapshot;
  captureProbeHits(probeId: string, data: ProbeHitsSnapshotInput): ProbeHitsSnapshot;
};

type GraphSnapshotInput = {
  entities: GraphSnapshot["entities"];
  edges: GraphSnapshot["edges"];
};

type IndexSnapshotInput = {
  documents: IndexSnapshot["documents"];
};

type ProbeHitsSnapshotInput = {
  hits: ProbeHitsSnapshot["hits"];
  matched: ProbeHitsSnapshot["matched"];
  missed: ProbeHitsSnapshot["missed"];
};

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || typeof value !== "object") {
    return value as DeepReadonly<T>;
  }

  if (Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  const target = value as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    const child = target[key];
    if (child !== null && typeof child === "object") {
      deepFreeze(child);
    }
  }

  return Object.freeze(value) as DeepReadonly<T>;
}

function immutableClone<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value));
}

export function createScenarioDebugger() {
  const graphSnapshots = new Map<string, GraphSnapshot>();
  const indexSnapshots = new Map<string, IndexSnapshot>();
  const probeHitsSnapshots = new Map<string, ProbeHitsSnapshot>();

  const api: ScenarioDebuggerCollector = {
    getGraphState(beatId: string): GraphSnapshot {
      const snapshot = graphSnapshots.get(beatId);
      if (!snapshot) {
        throw new Error(`Unknown beatId: ${beatId}`);
      }
      return snapshot;
    },

    getIndexedContent(beatId: string): IndexSnapshot {
      const snapshot = indexSnapshots.get(beatId);
      if (!snapshot) {
        throw new Error(`Unknown beatId: ${beatId}`);
      }
      return snapshot;
    },

    getProbeHits(probeId: string): ProbeHitsSnapshot {
      const snapshot = probeHitsSnapshots.get(probeId);
      if (!snapshot) {
        throw new Error(`Unknown probeId: ${probeId}`);
      }
      return snapshot;
    },

    captureGraphSnapshot(beatId: string, data: GraphSnapshotInput): GraphSnapshot {
      const snapshot = immutableClone({
        beatId,
        entities: data.entities,
        edges: data.edges,
      }) as GraphSnapshot;
      graphSnapshots.set(beatId, snapshot);
      return snapshot;
    },

    captureIndexSnapshot(beatId: string, data: IndexSnapshotInput): IndexSnapshot {
      const snapshot = immutableClone({
        beatId,
        documents: data.documents,
      }) as IndexSnapshot;
      indexSnapshots.set(beatId, snapshot);
      return snapshot;
    },

    captureProbeHits(probeId: string, data: ProbeHitsSnapshotInput): ProbeHitsSnapshot {
      const snapshot = immutableClone({
        probeId,
        hits: data.hits,
        matched: data.matched,
        missed: data.missed,
      }) as ProbeHitsSnapshot;
      probeHitsSnapshots.set(probeId, snapshot);
      return snapshot;
    },
  };

  return api;
}
