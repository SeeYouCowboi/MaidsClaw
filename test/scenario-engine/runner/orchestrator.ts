import { randomUUID } from "node:crypto";
import type { Story } from "../dsl/story-types.js";
import type { GeneratedDialogue } from "../generators/dialogue-generator.js";
import { generateOrLoadDialogue } from "../generators/scenario-cache.js";
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

export type ScenarioHandleExtended = ScenarioHandle & {
  settlementInfra?: ScenarioInfra;
};

export async function runScenario(
  story: Story,
  options?: RunOptions,
): Promise<ScenarioHandleExtended> {
  const resolvedOptions: RunOptions = {
    writePath: options?.writePath ?? "settlement",
    phase: options?.phase ?? "full",
    compareWithSettlement: options?.compareWithSettlement ?? false,
    keepSchema: options?.keepSchema ?? false,
  };

  const startMs = performance.now();

  const infra = await bootstrapScenarioSchema(story, resolvedOptions);

  if (resolvedOptions.phase === "probe_only") {
    return {
      infra,
      runResult: {
        entityIdMap: infra.entityIdMap,
        settlementCount: 0,
        projectionStats: {},
        errors: [],
        elapsedMs: 0,
        schemaName: infra.schemaName,
        writePath: resolvedOptions.writePath,
        phase: "probe_only",
      },
    };
  }

  const dialogue = await generateOrLoadDialogue(story);

  await seedInteractionHistory(infra, dialogue);

  const writeResult = await dispatchWritePath(
    resolvedOptions.writePath,
    infra,
    story,
    dialogue,
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
    errors: writeResult.errors,
    elapsedMs,
    schemaName: infra.schemaName,
    writePath: resolvedOptions.writePath,
    phase: resolvedOptions.phase ?? "full",
  };

  return { infra, runResult, settlementInfra };
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
