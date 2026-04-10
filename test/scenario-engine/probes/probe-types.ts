import type { StoryProbe } from "../dsl/index.js";

export type RetrievalHit = {
  content: string;
  score: number;
  source_ref: string;
  scope: string;
  // Populated only when coming from cognition_search
  conflictSummary?: string | null;
  conflictFactorRefs?: string[];
  resolution?: { type: string; by_node_ref: string } | null;
};

export type ProbeDefinition = StoryProbe;

export type ProbeResult = {
  probe: ProbeDefinition;
  hits: RetrievalHit[];
  matched: string[];
  missed: string[];
  unexpectedPresent: string[];
  score: number;
  passed: boolean;
  conflictFieldResults?: { field: string; expected: boolean; actual: boolean }[];
  latencyMs?: number; // populated by probe-executor when timing is available
};

export type ScenarioProbeReport = {
  storyTitle: string;
  totalProbes: number;
  passed: number;
  failed: number;
  probeResults: ProbeResult[];
  generatedAt: number;
};

export type MatchOptions = {
  mode: "deterministic" | "live";
  liveThreshold?: number;
};
