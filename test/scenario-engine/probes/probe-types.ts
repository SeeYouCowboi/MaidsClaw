import type { StoryProbe } from "../dsl/index.js";

export type RetrievalHit = {
  content: string;
  score: number;
  source_ref: string;
  scope: string;
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
