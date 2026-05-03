import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyWorldStateOpsForSettlement,
  ensureSyntheticAgentEntity,
  isWorldStateOpsProcessingEnabled,
  resolveWorldStateEntityRef,
  type GraphStoreRepoForWorldStateOps,
} from "../../src/memory/world-state-ops-applier.js";
import type { WorldStateOp } from "../../src/runtime/rp-turn-contract.js";

const FLAG = "MAIDSCLAW_WORLDSTATE_OPS_ENABLED";

function makeOp(overrides: Partial<WorldStateOp> = {}): WorldStateOp {
  return {
    subject: { kind: "pointer_key", value: "char:alice" },
    predicate: "knows",
    object: { kind: "pointer_key", value: "char:bob" },
    factText: "alice knows bob",
    contradictedFactEdgeIds: [],
    ...overrides,
  } as WorldStateOp;
}

function makeGraphRepo() {
  return {
    resolveEntityByPointerKey: mock(async (_key: string, _agent: string) => null as number | null),
    createWorldStateFactEdge: mock(async (_args: unknown) => 999),
    upsertEntity: mock(async (_args: unknown) => 555),
  } as GraphStoreRepoForWorldStateOps & {
    resolveEntityByPointerKey: ReturnType<typeof mock>;
    createWorldStateFactEdge: ReturnType<typeof mock>;
    upsertEntity: ReturnType<typeof mock>;
  };
}

function makeUnresolvedRepo() {
  return {
    enqueueOp: mock(async (_args: unknown) => undefined),
  };
}

describe("applyWorldStateOpsForSettlement (area 11/12 shared applier)", () => {
  let warnSpy: ReturnType<typeof mock>;
  let errorSpy: ReturnType<typeof mock>;
  const origWarn = console.warn;
  const origError = console.error;

  beforeEach(() => {
    warnSpy = mock(() => undefined);
    errorSpy = mock(() => undefined);
    console.warn = warnSpy as unknown as typeof console.warn;
    console.error = errorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    delete process.env[FLAG];
    console.warn = origWarn;
    console.error = origError;
  });

  describe("env-flag short-circuit", () => {
    it("returns disabled=true and writes nothing when flag is '0'", async () => {
      process.env[FLAG] = "0";
      const graph = makeGraphRepo();
      const unresolved = makeUnresolvedRepo();
      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:abc",
        sessionId: "sess",
        agentId: "agent-1",
        worldStateOps: [makeOp()],
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
      });
      expect(result.disabled).toBe(true);
      expect(result.processedOps).toBe(0);
      expect(graph.createWorldStateFactEdge).toHaveBeenCalledTimes(0);
      expect(unresolved.enqueueOp).toHaveBeenCalledTimes(0);
    });

    it("isWorldStateOpsProcessingEnabled defaults to true when flag absent", () => {
      delete process.env[FLAG];
      expect(isWorldStateOpsProcessingEnabled()).toBe(true);
    });

    it("isWorldStateOpsProcessingEnabled returns false only for '0'", () => {
      process.env[FLAG] = "0";
      expect(isWorldStateOpsProcessingEnabled()).toBe(false);
      process.env[FLAG] = "1";
      expect(isWorldStateOpsProcessingEnabled()).toBe(true);
      process.env[FLAG] = "true";
      expect(isWorldStateOpsProcessingEnabled()).toBe(true);
    });
  });

  describe("empty ops list", () => {
    it("returns zero counters when no ops provided (worldStateOps undefined)", async () => {
      delete process.env[FLAG];
      const graph = makeGraphRepo();
      const unresolved = makeUnresolvedRepo();
      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:abc",
        sessionId: "sess",
        agentId: "agent-1",
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
      });
      expect(result).toEqual({
        disabled: false,
        processedOps: 0,
        writtenOps: 0,
        enqueuedOps: 0,
        skippedOps: 0,
        failedOps: 0,
      });
    });

    it("falls back to settlementPayload.worldStateOps when worldStateOps not given", async () => {
      delete process.env[FLAG];
      const graph = makeGraphRepo();
      graph.resolveEntityByPointerKey.mockImplementation(async () => 100);
      const unresolved = makeUnresolvedRepo();
      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:abc",
        sessionId: "sess",
        agentId: "agent-1",
        settlementPayload: { worldStateOps: [makeOp()] },
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
      });
      expect(result.processedOps).toBe(1);
      expect(result.writtenOps).toBe(1);
    });
  });

  describe("happy path: both refs resolve", () => {
    it("creates a world state fact edge with settlement-derived sourceRef and contradictedFactEdgeIds", async () => {
      delete process.env[FLAG];
      const graph = makeGraphRepo();
      graph.resolveEntityByPointerKey.mockImplementation(async (key: string) => {
        if (key === "char:alice") return 11;
        if (key === "char:bob") return 22;
        return null;
      });
      const unresolved = makeUnresolvedRepo();
      const op = makeOp({ contradictedFactEdgeIds: [101, 102] });

      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:xyz",
        sessionId: "sess",
        agentId: "agent-1",
        worldStateOps: [op],
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
        settledAt: 1234567890,
      });

      expect(result).toEqual({
        disabled: false,
        processedOps: 1,
        writtenOps: 1,
        enqueuedOps: 0,
        skippedOps: 0,
        failedOps: 0,
      });
      expect(graph.createWorldStateFactEdge).toHaveBeenCalledTimes(1);
      const callArgs = (graph.createWorldStateFactEdge.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(callArgs.sourceEntityId).toBe(11);
      expect(callArgs.targetEntityId).toBe(22);
      expect(callArgs.predicate).toBe("knows");
      expect(callArgs.factText).toBe("alice knows bob");
      expect(callArgs.ownerAgentId).toBe("agent-1");
      expect(callArgs.sourceKind).toBe("settlement");
      expect(callArgs.sourceRef).toBe("stl:xyz:0");
      expect(callArgs.tValid).toBe(1234567890);
      expect(callArgs.contradictedFactEdgeIds).toEqual([101, 102]);
    });
  });

  describe("enqueue path: pointer_key unresolved", () => {
    it("enqueues op with pointer keys preserved when both pointers fail to resolve", async () => {
      delete process.env[FLAG];
      const graph = makeGraphRepo();
      graph.resolveEntityByPointerKey.mockImplementation(async () => null);
      const unresolved = makeUnresolvedRepo();
      const op = makeOp();

      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:xyz",
        sessionId: "sess-77",
        agentId: "agent-1",
        worldStateOps: [op],
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
      });

      expect(result.enqueuedOps).toBe(1);
      expect(result.writtenOps).toBe(0);
      expect(result.skippedOps).toBe(0);
      expect(unresolved.enqueueOp).toHaveBeenCalledTimes(1);
      const enqArgs = (unresolved.enqueueOp.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(enqArgs.sessionId).toBe("sess-77");
      expect(enqArgs.settlementId).toBe("stl:xyz");
      expect(enqArgs.opIndex).toBe(0);
      expect(enqArgs.subjectPointerKey).toBe("char:alice");
      expect(enqArgs.objectPointerKey).toBe("char:bob");
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("skip path: special_unresolved (special:user with no viewerSnapshot)", () => {
    it("skips (does not enqueue) when special:user fails because viewerSnapshot.userPointerKey absent", async () => {
      delete process.env[FLAG];
      const graph = makeGraphRepo();
      graph.resolveEntityByPointerKey.mockImplementation(async () => 50);
      const unresolved = makeUnresolvedRepo();
      const op = makeOp({
        subject: { kind: "special", value: "user" } as WorldStateOp["subject"],
      });

      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:xyz",
        sessionId: "sess",
        agentId: "agent-1",
        worldStateOps: [op],
        viewerSnapshot: undefined,
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
      });

      expect(result.skippedOps).toBe(1);
      expect(result.enqueuedOps).toBe(0);
      expect(result.writtenOps).toBe(0);
      expect(unresolved.enqueueOp).toHaveBeenCalledTimes(0);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("failure path: createWorldStateFactEdge throws", () => {
    it("increments failedOps and continues processing remaining ops", async () => {
      delete process.env[FLAG];
      const graph = makeGraphRepo();
      graph.resolveEntityByPointerKey.mockImplementation(async () => 7);
      let calls = 0;
      graph.createWorldStateFactEdge.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return 1;
      });
      const unresolved = makeUnresolvedRepo();

      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:xyz",
        sessionId: "sess",
        agentId: "agent-1",
        worldStateOps: [makeOp(), makeOp({ factText: "second" })],
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
      });

      expect(result.processedOps).toBe(2);
      expect(result.failedOps).toBe(1);
      expect(result.writtenOps).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe("self / current_location resolution via viewerSnapshot", () => {
    it("resolves special:self via selfPointerKey and special:current_location via numeric id", async () => {
      delete process.env[FLAG];
      const graph = makeGraphRepo();
      graph.resolveEntityByPointerKey.mockImplementation(async (key: string) => {
        if (key === "viewer:self-key") return 1001;
        return null;
      });
      const unresolved = makeUnresolvedRepo();

      const op = makeOp({
        subject: { kind: "special", value: "self" } as WorldStateOp["subject"],
        object: { kind: "special", value: "current_location" } as WorldStateOp["object"],
      });

      const result = await applyWorldStateOpsForSettlement({
        settlementId: "stl:xyz",
        sessionId: "sess",
        agentId: "agent-1",
        worldStateOps: [op],
        viewerSnapshot: {
          selfPointerKey: "viewer:self-key",
          userPointerKey: "viewer:user-key",
          currentLocationEntityId: 2002,
        },
        graphStoreRepo: graph,
        unresolvedOpsRepo: unresolved,
      });

      expect(result.writtenOps).toBe(1);
      const callArgs = (graph.createWorldStateFactEdge.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(callArgs.sourceEntityId).toBe(1001);
      expect(callArgs.targetEntityId).toBe(2002);
    });

    it("special:self falls back to ensureSyntheticAgentEntity when selfPointerKey resolves to null", async () => {
      delete process.env[FLAG];
      const graph = makeGraphRepo();
      graph.resolveEntityByPointerKey.mockImplementation(async () => null);
      graph.upsertEntity.mockImplementation(async () => 9090);
      const result = await resolveWorldStateEntityRef({
        ref: { kind: "special", value: "self" } as WorldStateOp["subject"],
        viewerSnapshot: {
          selfPointerKey: "viewer:self-key",
          userPointerKey: "viewer:user-key",
          currentLocationEntityId: 2,
        },
        agentId: "agent-X",
        graphStoreRepo: graph,
        settlementId: "stl:1",
        opIndex: 0,
        endpoint: "subject",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entityId).toBe(9090);
    });
  });

  describe("ensureSyntheticAgentEntity", () => {
    it("delegates to private method when graphStoreRepo provides one", async () => {
      const fastPath = mock(async (_id: string) => 4242);
      const repo = {
        resolveEntityByPointerKey: mock(async () => null),
        createWorldStateFactEdge: mock(async () => 1),
        upsertEntity: mock(async () => 9),
        ensureSyntheticAgentEntity: fastPath,
      } as unknown as GraphStoreRepoForWorldStateOps;
      const id = await ensureSyntheticAgentEntity(repo, "agent-Z");
      expect(id).toBe(4242);
      expect(fastPath).toHaveBeenCalledWith("agent-Z");
    });

    it("falls back to upsertEntity with __agent__: pointer key when no private method", async () => {
      const repo = makeGraphRepo();
      repo.upsertEntity.mockImplementation(async () => 7777);
      const id = await ensureSyntheticAgentEntity(repo, "agent-Z");
      expect(id).toBe(7777);
      const call = (repo.upsertEntity.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(call.pointerKey).toBe("__agent__:agent-Z");
      expect(call.entityType).toBe("agent");
      expect(call.memoryScope).toBe("private_overlay");
      expect(call.ownerAgentId).toBe("agent-Z");
    });
  });
});

describe("ProjectionManager + ExplicitSettlementProcessor wiring (area 11/12 source-grep)", () => {
  const root = process.cwd();

  it("ProjectionManager.commitSettlement delegates worldStateOps to applyWorldStateOpsForSettlement", () => {
    const src = readFileSync(
      join(root, "src/memory/projection/projection-manager.ts"),
      "utf8",
    );
    expect(src).toContain('from "../world-state-ops-applier.js"');
    expect(src).toContain("applyWorldStateOpsForSettlement");
    expect(src).toMatch(/commitSettlement\s*\(/);
    expect(src).toContain("worldStateOps");
  });

  it("ExplicitSettlementProcessor.process delegates worldStateOps to applyWorldStateOpsForSettlement", () => {
    const src = readFileSync(
      join(root, "src/memory/explicit-settlement-processor.ts"),
      "utf8",
    );
    expect(src).toContain('from "./world-state-ops-applier.js"');
    expect(src).toContain("applyWorldStateOpsForSettlement");
    expect(src).toMatch(/async process\(/);
    expect(src).toContain("worldStateOps");
  });

  it("both call sites pass agentId, settlementId, sessionId, viewerSnapshot, graphStoreRepo, unresolvedOpsRepo", () => {
    for (const path of [
      "src/memory/projection/projection-manager.ts",
      "src/memory/explicit-settlement-processor.ts",
    ]) {
      const src = readFileSync(join(root, path), "utf8");
      expect(src).toMatch(/applyWorldStateOpsForSettlement\s*\(\s*\{[\s\S]+?settlementId:/);
      expect(src).toMatch(/applyWorldStateOpsForSettlement\s*\(\s*\{[\s\S]+?sessionId:/);
      expect(src).toMatch(/applyWorldStateOpsForSettlement\s*\(\s*\{[\s\S]+?agentId:/);
      expect(src).toMatch(/applyWorldStateOpsForSettlement\s*\(\s*\{[\s\S]+?viewerSnapshot/);
      expect(src).toMatch(/applyWorldStateOpsForSettlement\s*\(\s*\{[\s\S]+?graphStoreRepo:/);
      expect(src).toMatch(/applyWorldStateOpsForSettlement\s*\(\s*\{[\s\S]+?unresolvedOpsRepo:/);
    }
  });
});
