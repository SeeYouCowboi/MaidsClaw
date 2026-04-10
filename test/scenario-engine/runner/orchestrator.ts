import { randomUUID } from "node:crypto";
import type { Story } from "../dsl/story-types.js";
import type { GeneratedDialogue } from "../generators/dialogue-generator.js";
import {
  deleteCheckpoint,
  generateOrLoadDialogue,
  loadCachedDialogue,
} from "../generators/scenario-cache.js";
import {
  SCENARIO_DEFAULT_SESSION_ID,
  SCENARIO_ENGINE_BASE_TIME,
} from "../constants.js";
import {
  bootstrapScenarioSchema,
  type RunOptions,
  type ScenarioHandle,
  type ScenarioInfra,
  type ScenarioRunResult,
} from "./infra.js";
import {
  executeLivePath,
  executeScriptedPath,
  executeSettlementPath,
  type WritePathResult,
} from "./write-paths.js";
import { assertToolCallPatterns } from "../probes/tool-call-asserter.js";
import { verifyReasoningChains } from "../probes/reasoning-chain-verifier.js";
import { executeProbes } from "../probes/probe-executor.js";
import {
  diagnoseProbeFailure,
  type DiagnosisResult,
} from "../probes/probe-diagnosis.js";
import type { ProbeResult } from "../probes/probe-types.js";
import type {
  ReasoningChainResult,
  ToolCallAssertionResult,
} from "../probes/scenario-assertion-types.js";
import type { PlanSurfaceProbeResult } from "../probes/plan-surface-probe.js";

export type ScenarioHandleExtended = ScenarioHandle & {
  settlementInfra?: ScenarioInfra;
  capturedToolCallLog?: WritePathResult["capturedToolCallLog"];
  toolCallAssertionResults?: ToolCallAssertionResult[];
  chainResults?: ReasoningChainResult[];
  diagnosisResults?: Map<string, DiagnosisResult[]>;
  /** GAP-4: plan surface / drilldown shadow probe results. */
  planSurfaceResults?: PlanSurfaceProbeResult[];
};

export async function runProbeFailureDiagnosis(
  probeResults: ProbeResult[],
  infra: ScenarioInfra,
  writePath: RunOptions["writePath"],
): Promise<Map<string, DiagnosisResult[]>> {
  const diagnosisResults = new Map<string, DiagnosisResult[]>();

  for (const result of probeResults) {
    if (!result.passed) {
      const diagnosis = await diagnoseProbeFailure(
        result.probe,
        result.missed,
        infra,
        writePath,
      );
      diagnosisResults.set(result.probe.id, diagnosis);
    }
  }

  return diagnosisResults;
}

export async function executeProbesWithDiagnosis(
  story: Story,
  handle: ScenarioHandleExtended,
): Promise<ProbeResult[]> {
  const probeResults = await executeProbes(story, handle);
  handle.diagnosisResults = await runProbeFailureDiagnosis(
    probeResults,
    handle.infra,
    handle.runResult.writePath,
  );
  return probeResults;
}

export async function runScenario(
  story: Story,
  options?: RunOptions,
): Promise<ScenarioHandleExtended> {
  const resolvedOptions: RunOptions = {
    writePath: options?.writePath ?? "settlement",
    phase: options?.phase ?? "full",
    compareWithSettlement: options?.compareWithSettlement ?? false,
    keepSchema: options?.keepSchema ?? true,
  };

  const startMs = performance.now();

  const infra = await bootstrapScenarioSchema(story, resolvedOptions);

  if (resolvedOptions.phase === "probe_only") {
    const chainResults = await verifyReasoningChains(
      story.reasoningChainProbes ?? [],
      infra,
    );

    return {
      infra,
      runResult: {
        entityIdMap: infra.entityIdMap,
        settlementCount: 0,
        projectionStats: {},
        perBeatStats: [],
        errors: [],
        elapsedMs: 0,
        schemaName: infra.schemaName,
        writePath: resolvedOptions.writePath,
        phase: "probe_only",
      },
      capturedToolCallLog: undefined,
      toolCallAssertionResults: [],
      chainResults,
      diagnosisResults: new Map<string, DiagnosisResult[]>(),
    };
  }

  // Full live run: clear stale checkpoint so every beat is reprocessed.
  if (resolvedOptions.writePath === "live" && resolvedOptions.phase === "full") {
    deleteCheckpoint(story.id);
  }

  // Settlement path doesn't need dialogue for its core processing. Avoid
  // triggering LLM-based dialogue generation when no cache exists.
  const dialogue: GeneratedDialogue[] =
    resolvedOptions.writePath === "settlement"
      ? (loadCachedDialogue(story.id) ?? [])
      : await generateOrLoadDialogue(story);

  await seedInteractionHistory(infra, dialogue);

  const writeResult = await dispatchWritePath(
    resolvedOptions.writePath,
    infra,
    story,
    dialogue,
  );

  const toolCallAssertionResults = assertToolCallPatterns(
    story.beats,
    writeResult.capturedToolCallLog?.beats ?? [],
  );
  const chainResults = await verifyReasoningChains(
    story.reasoningChainProbes ?? [],
    infra,
  );

  let settlementInfra: ScenarioInfra | undefined;
  if (resolvedOptions.compareWithSettlement && resolvedOptions.writePath !== "settlement") {
    const secondaryOptions: RunOptions = {
      writePath: "settlement",
      phase: "full",
      keepSchema: resolvedOptions.keepSchema,
    };
    settlementInfra = await bootstrapScenarioSchema(story, secondaryOptions);
    await seedInteractionHistory(settlementInfra, dialogue);
    await executeSettlementPath(settlementInfra, story);
  }

  const elapsedMs = performance.now() - startMs;
  const runResult: ScenarioRunResult = {
    entityIdMap: infra.entityIdMap,
    settlementCount: writeResult.beatsProcessed,
    projectionStats: {},
    perBeatStats: writeResult.perBeatStats ?? [],
    errors: writeResult.errors,
    elapsedMs,
    schemaName: infra.schemaName,
    writePath: resolvedOptions.writePath,
    phase: resolvedOptions.phase ?? "full",
  };

  return {
    infra,
    runResult,
    settlementInfra,
    capturedToolCallLog: writeResult.capturedToolCallLog,
    toolCallAssertionResults,
    chainResults,
    diagnosisResults: new Map<string, DiagnosisResult[]>(),
  };
}

async function seedInteractionHistory(
  infra: ScenarioInfra,
  dialogue: GeneratedDialogue[],
): Promise<void> {
  let globalIndex = 0;

  for (const entry of dialogue) {
    for (const turn of entry.turns) {
      await infra.repos.interaction.commit({
        sessionId: SCENARIO_DEFAULT_SESSION_ID,
        recordId: randomUUID(),
        recordIndex: globalIndex,
        actorType: turn.role === "user" ? "user" : "rp_agent",
        recordType: "message",
        payload: { role: turn.role, content: turn.content },
        committedAt: turn.timestamp || SCENARIO_ENGINE_BASE_TIME + globalIndex * 1000,
      });
      globalIndex += 1;
    }
  }
}

async function dispatchWritePath(
  writePath: RunOptions["writePath"],
  infra: ScenarioInfra,
  story: Story,
  dialogue: GeneratedDialogue[],
): Promise<WritePathResult> {
  switch (writePath) {
    case "settlement":
      return executeSettlementPath(infra, story);
    case "scripted":
      return executeScriptedPath(infra, story, dialogue);
    case "live":
      return executeLivePath(infra, story, dialogue);
    default: {
      const _exhaustive: never = writePath;
      throw new Error(`Unknown write path: ${_exhaustive}`);
    }
  }
}
