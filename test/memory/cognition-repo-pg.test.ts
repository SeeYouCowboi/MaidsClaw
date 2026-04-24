import { describe, expect, it } from "bun:test";
import type { AssertionBasis, AssertionStance } from "../../src/runtime/rp-turn-contract.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import type { CognitionEventAppendParams, CognitionEventRow } from "../../src/memory/cognition/cognition-event-repo.js";
import type { CognitionCurrentRow } from "../../src/memory/cognition/private-cognition-current.js";
import type { NodeRef } from "../../src/memory/types.js";
import type { CognitionEventRepo } from "../../src/storage/domain-repos/contracts/cognition-event-repo.js";
import type { CognitionProjectionRepo } from "../../src/storage/domain-repos/contracts/cognition-projection-repo.js";
import type {
  SearchProjectionRepo,
  SearchProjectionScope,
  UpsertCognitionDocParams,
} from "../../src/storage/domain-repos/contracts/search-projection-repo.js";

function keyFor(agentId: string, cognitionKey: string): string {
  return `${agentId}::${cognitionKey}`;
}

function parseRowRecordJson(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return {};
}

class MockCognitionEventRepo implements CognitionEventRepo {
  public nextId = 1;
  public readonly appendCalls: CognitionEventAppendParams[] = [];
  public readonly rows: CognitionEventRow[] = [];

  async append(params: CognitionEventAppendParams): Promise<number> {
    const id = this.nextId++;
    this.appendCalls.push(params);
    this.rows.push({
      id,
      agent_id: params.agentId,
      cognition_key: params.cognitionKey,
      kind: params.kind,
      op: params.op,
      record_json: params.recordJson,
      settlement_id: params.settlementId,
      committed_time: params.committedTime,
      created_at: params.committedTime,
    });
    return id;
  }

  async readByAgent(agentId: string): Promise<CognitionEventRow[]> {
    return this.rows.filter((row) => row.agent_id === agentId);
  }

  async readByCognitionKey(agentId: string, cognitionKey: string): Promise<CognitionEventRow[]> {
    return this.rows.filter((row) => row.agent_id === agentId && row.cognition_key === cognitionKey);
  }

  async replay(agentId: string, afterTime?: number): Promise<CognitionEventRow[]> {
    if (afterTime === undefined) {
      return this.readByAgent(agentId);
    }
    return this.rows.filter((row) => row.agent_id === agentId && row.committed_time > afterTime);
  }
}

class MockCognitionProjectionRepo implements CognitionProjectionRepo {
  public readonly state = new Map<string, CognitionCurrentRow>();
  public readonly upsertEvents: CognitionEventRow[] = [];
  public nextProjectionId = 1;
  public throwOnNextUpsert = false;

  async upsertFromEvent(event: CognitionEventRow): Promise<void> {
    this.upsertEvents.push(event);
    if (this.throwOnNextUpsert) {
      this.throwOnNextUpsert = false;
      throw new Error("projection failed");
    }

    const mapKey = keyFor(event.agent_id, event.cognition_key);
    const existing = this.state.get(mapKey);

    if (event.op === "retract") {
      if (!existing) return;
      if (existing.kind === "assertion") {
        existing.status = "retracted";
        existing.stance = "rejected";
      } else {
        existing.status = "retracted";
      }
      existing.source_event_id = event.id;
      existing.updated_at = event.committed_time;
      return;
    }

    const parsed = event.record_json ? JSON.parse(event.record_json) as Record<string, unknown> : {};
    const incomingVersion =
      typeof parsed.sourceTurnVersion === "number" && Number.isFinite(parsed.sourceTurnVersion)
        ? parsed.sourceTurnVersion
        : 0;

    if (existing && event.op !== "retract") {
      const existingParsed = existing.record_json
        ? JSON.parse(existing.record_json) as Record<string, unknown>
        : {};
      const existingVersion =
        typeof existingParsed.sourceTurnVersion === "number" && Number.isFinite(existingParsed.sourceTurnVersion)
          ? existingParsed.sourceTurnVersion
          : 0;
      if (incomingVersion < existingVersion) {
        return;
      }
      if (incomingVersion === existingVersion && event.committed_time < existing.updated_at) {
        return;
      }
    }
    const base: CognitionCurrentRow = {
      id: existing?.id ?? this.nextProjectionId++,
      agent_id: event.agent_id,
      cognition_key: event.cognition_key,
      kind: event.kind,
      stance: null,
      basis: null,
      status: "active",
      pre_contested_stance: null,
      conflict_summary: null,
      conflict_factor_refs_json: null,
      summary_text: null,
      record_json: event.record_json ?? "{}",
      source_event_id: event.id,
      updated_at: event.committed_time,
    };

    if (event.kind === "assertion") {
      const sourcePointerKey =
        typeof parsed.holderPointerKey === "string"
          ? parsed.holderPointerKey
          : (typeof parsed.sourcePointerKey === "string" ? parsed.sourcePointerKey : "?");
      const predicate =
        typeof parsed.claim === "string"
          ? parsed.claim
          : (typeof parsed.predicate === "string" ? parsed.predicate : null);
      const targetPointerKey =
        Array.isArray(parsed.entityPointerKeys) && parsed.entityPointerKeys.length > 0 && typeof parsed.entityPointerKeys[0] === "string"
          ? String(parsed.entityPointerKeys[0])
          : (typeof parsed.targetPointerKey === "string" ? parsed.targetPointerKey : "?");
      base.kind = "assertion";
      base.stance = (parsed.stance as string | null) ?? null;
      base.basis = (parsed.basis as string | null) ?? null;
      base.status = "active";
      base.pre_contested_stance = (parsed.preContestedStance as string | null) ?? null;
      base.summary_text = predicate ? `${predicate}: ${sourcePointerKey} → ${targetPointerKey}` : null;
    } else if (event.kind === "evaluation") {
      const notes = typeof parsed.notes === "string" ? parsed.notes : "";
      base.kind = "evaluation";
      base.summary_text = `evaluation: ${notes}`;
      base.status = "active";
    } else {
      const mode = typeof parsed.mode === "string" ? parsed.mode : "goal";
      const target = parsed.target !== undefined ? JSON.stringify(parsed.target) : "";
      base.kind = "commitment";
      base.summary_text = `${mode}: ${target}`;
      base.status = typeof parsed.status === "string" ? parsed.status : "active";
    }

    this.state.set(mapKey, base);
  }

  async rebuild(_agentId: string): Promise<void> {}

  async getCurrent(agentId: string, cognitionKey: string): Promise<CognitionCurrentRow | null> {
    return this.state.get(keyFor(agentId, cognitionKey)) ?? null;
  }

  async getAllCurrent(agentId: string): Promise<CognitionCurrentRow[]> {
    return [...this.state.values()]
      .filter((row) => row.agent_id === agentId)
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  async updateConflictFactors(): Promise<void> {}

  async patchRecordJsonSourceEventRef(id: number, sourceEventRef: string, updatedAt: number): Promise<void> {
    for (const row of this.state.values()) {
      if (row.id !== id) continue;
      const parsed = JSON.parse(row.record_json) as Record<string, unknown>;
      parsed.sourceEventRef = sourceEventRef;
      row.record_json = JSON.stringify(parsed);
      row.updated_at = updatedAt;
      return;
    }
  }

  async resolveEntityByPointerKey(): Promise<number | null> {
    return null;
  }
}

type CognitionDocRow = UpsertCognitionDocParams & { id: number };

class MockSearchProjectionRepo implements SearchProjectionRepo {
  public readonly docs = new Map<string, CognitionDocRow>();
  public readonly upsertCalls: UpsertCognitionDocParams[] = [];
  public readonly stanceUpdateCalls: Array<{ sourceRef: NodeRef; agentId: string; stance: string; updatedAt: number }> = [];
  public nextId = 1;

  async syncSearchDoc(
    _scope: "area" | "world",
    _sourceRef: NodeRef,
    _content: string,
    _agentId?: string,
    _locationEntityId?: number,
  ): Promise<number> {
    return 0;
  }

  async removeSearchDoc(_scope: "area" | "world", _sourceRef: NodeRef): Promise<void> {}

  async rebuildForScope(_scope: SearchProjectionScope, _agentId?: string): Promise<void> {}

  async upsertCognitionDoc(params: UpsertCognitionDocParams): Promise<number> {
    this.upsertCalls.push(params);
    const key = `${params.agentId}::${params.sourceRef}`;
    const existing = this.docs.get(key);
    if (existing) {
      existing.kind = params.kind;
      existing.basis = params.basis ?? null;
      existing.stance = params.stance ?? null;
      existing.content = params.content;
      existing.updatedAt = params.updatedAt;
      existing.createdAt = params.createdAt;
      return existing.id;
    }

    const id = this.nextId++;
    this.docs.set(key, {
      ...params,
      id,
    });
    return id;
  }

  async upsertEpisodeDoc(): Promise<number> {
    return 0;
  }

  async updateCognitionSearchDocStanceBySourceRef(
    sourceRef: NodeRef,
    agentId: string,
    stance: string,
    updatedAt: number,
  ): Promise<void> {
    this.stanceUpdateCalls.push({ sourceRef, agentId, stance, updatedAt });
    const key = `${agentId}::${sourceRef}`;
    const existing = this.docs.get(key);
    if (!existing) return;
    existing.stance = stance;
    existing.updatedAt = updatedAt;
  }
}

describe("CognitionRepository (PG repos, unit)", () => {
  it("supports all 7 assertion stances via async PG repo flow", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const resolver = async (pointerKey: string): Promise<number | null> => {
      if (pointerKey === "maid:a") return 100;
      if (pointerKey === "maid:b") return 200;
      return null;
    };

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: resolver,
    });

    const stances: Array<{ stance: AssertionStance; basis?: AssertionBasis; pre?: AssertionStance }> = [
      { stance: "hypothetical", basis: "belief" },
      { stance: "tentative", basis: "inference" },
      { stance: "accepted", basis: "first_hand" },
      { stance: "confirmed", basis: "first_hand" },
      { stance: "contested", basis: "first_hand", pre: "accepted" },
      { stance: "rejected", basis: "first_hand" },
      { stance: "abandoned", basis: "hearsay" },
    ];

    for (let index = 0; index < stances.length; index += 1) {
      const input = stances[index];
      const key = `stance:${input.stance}`;
      const result = await repo.upsertAssertion({
        agentId: "agent-1",
        cognitionKey: key,
        settlementId: "settlement-1",
        opIndex: index,
        holderPointerKey: "maid:a",
        claim: "knows",
        entityPointerKeys: ["maid:a", "maid:b"],
        stance: input.stance,
        basis: input.basis,
        preContestedStance: input.pre,
      });
      expect(result.id).toBeGreaterThan(0);
      const assertion = await repo.getAssertionByKey("agent-1", key);
      expect(assertion).not.toBeNull();
      expect(assertion!.stance).toBe(input.stance);
    }

    expect(eventRepo.appendCalls).toHaveLength(7);
    expect(searchRepo.upsertCalls).toHaveLength(7);
  });

  it("applies event append before projection+search and stops search on projection failure", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    projectionRepo.throwOnNextUpsert = true;
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await expect(repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "atomic:key",
      settlementId: "settlement-atomic",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "supports",
      entityPointerKeys: ["src", "dst"],
      stance: "tentative",
      basis: "hearsay",
    })).rejects.toThrow("projection failed");

    expect(eventRepo.appendCalls).toHaveLength(1);
    expect(projectionRepo.upsertEvents).toHaveLength(1);
    expect(searchRepo.upsertCalls).toHaveLength(0);
  });

  it("uses injected entity resolver (private overlay over shared public)", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const resolverCalls: Array<{ pointerKey: string; agentId: string }> = [];
    const privateOverlay = new Map<string, number>([
      ["agent-1::pointer:shared", 999],
    ]);
    const sharedPublic = new Map<string, number>([
      ["pointer:shared", 101],
      ["pointer:target", 202],
    ]);

    const resolver = async (pointerKey: string, agentId: string): Promise<number | null> => {
      resolverCalls.push({ pointerKey, agentId });
      const privateKey = `${agentId}::${pointerKey}`;
      if (privateOverlay.has(privateKey)) {
        return privateOverlay.get(privateKey) ?? null;
      }
      if (sharedPublic.has(pointerKey)) {
        return sharedPublic.get(pointerKey) ?? null;
      }
      return null;
    };

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: resolver,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "resolve:key",
      settlementId: "settlement-resolve",
      opIndex: 1,
      holderPointerKey: "pointer:shared",
      claim: "trusts",
      entityPointerKeys: ["pointer:target"],
      stance: "accepted",
      basis: "first_hand",
    });

    const row = await repo.getAssertionByKey("agent-1", "resolve:key");
    expect(row).not.toBeNull();
    expect(row!.sourceEntityId).toBe(999);
    expect(row!.targetEntityId).toBe(202);
    expect(resolverCalls).toEqual([
      { pointerKey: "pointer:shared", agentId: "agent-1" },
      { pointerKey: "pointer:target", agentId: "agent-1" },
      { pointerKey: "pointer:shared", agentId: "agent-1" },
      { pointerKey: "pointer:target", agentId: "agent-1" },
    ]);
  });

  it("syncs search_docs_cognition via upsert + stance update by source_ref", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    const upserted = await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "search:key",
      settlementId: "settlement-search",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "claims",
      entityPointerKeys: ["src", "dst"],
      stance: "tentative",
      basis: "hearsay",
    });

    expect(upserted.id).toBeGreaterThan(0);
    expect(searchRepo.upsertCalls).toHaveLength(1);
    expect(searchRepo.upsertCalls[0].sourceRef).toBe(`assertion:${upserted.id}`);
    expect(searchRepo.upsertCalls[0].stance).toBe("tentative");

    await repo.retractCognition("agent-1", "search:key", "assertion", "settlement-retract");

    expect(searchRepo.stanceUpdateCalls).toHaveLength(1);
    expect(searchRepo.stanceUpdateCalls[0].sourceRef).toBe(`assertion:${upserted.id}`);
    expect(searchRepo.stanceUpdateCalls[0].agentId).toBe("agent-1");
    expect(searchRepo.stanceUpdateCalls[0].stance).toBe("rejected");
  });

  it("default repo path blocks basis downgrade for non-thinker callers", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "state:basis:downgrade:block",
      settlementId: "settlement-1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "keeps evidence",
      entityPointerKeys: ["src", "dst"],
      stance: "accepted",
      basis: "first_hand",
      provenance: "talker_sketch_auto",
    });

    await expect(
      repo.upsertAssertion({
        agentId: "agent-1",
        cognitionKey: "state:basis:downgrade:block",
        settlementId: "settlement-2",
        opIndex: 1,
        holderPointerKey: "src",
        claim: "keeps evidence",
        entityPointerKeys: ["src", "dst"],
        stance: "accepted",
        basis: "belief",
        provenance: "talker_sketch_auto",
      }),
    ).rejects.toThrow("assertion basis change is not an allowed upgrade");
  });

  it("default repo path blocks confirmed→tentative downgrade for non-thinker callers", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "state:stance:downgrade:block",
      settlementId: "settlement-1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "is true",
      entityPointerKeys: ["src", "dst"],
      stance: "confirmed",
      basis: "first_hand",
      provenance: "talker_sketch_explicit",
    });

    await expect(
      repo.upsertAssertion({
        agentId: "agent-1",
        cognitionKey: "state:stance:downgrade:block",
        settlementId: "settlement-2",
        opIndex: 1,
        holderPointerKey: "src",
        claim: "is true",
        entityPointerKeys: ["src", "dst"],
        stance: "tentative",
        basis: "first_hand",
        provenance: "talker_sketch_explicit",
      }),
    ).rejects.toThrow("illegal stance transition");
  });

  it("thinker-only path allows confirmed→tentative for sketch-origin assertions", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "state:stance:downgrade:allow",
      settlementId: "settlement-1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "is true",
      entityPointerKeys: ["src", "dst"],
      stance: "confirmed",
      basis: "first_hand",
      provenance: "talker_sketch_auto",
      isThinkerGuardrailPath: true,
    });

    await expect(
      repo.upsertAssertion({
        agentId: "agent-1",
        cognitionKey: "state:stance:downgrade:allow",
        settlementId: "settlement-2",
        opIndex: 1,
        holderPointerKey: "src",
        claim: "is true",
        entityPointerKeys: ["src", "dst"],
        stance: "tentative",
        basis: "belief",
        provenance: "talker_sketch_auto",
        isThinkerGuardrailPath: true,
      }),
    ).resolves.toEqual({ id: expect.any(Number) });

    const row = await repo.getAssertionByKey("agent-1", "state:stance:downgrade:allow");
    expect(row?.stance).toBe("tentative");
  });

  it("thinker-only path allows basis downgrade to belief for sketch-origin assertions", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "state:basis:downgrade:allow",
      settlementId: "settlement-1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "keeps evidence",
      entityPointerKeys: ["src", "dst"],
      stance: "accepted",
      basis: "first_hand",
      provenance: "talker_sketch_explicit",
      isThinkerGuardrailPath: true,
    });

    await expect(
      repo.upsertAssertion({
        agentId: "agent-1",
        cognitionKey: "state:basis:downgrade:allow",
        settlementId: "settlement-2",
        opIndex: 1,
        holderPointerKey: "src",
        claim: "keeps evidence",
        entityPointerKeys: ["src", "dst"],
        stance: "accepted",
        basis: "belief",
        provenance: "talker_sketch_explicit",
        isThinkerGuardrailPath: true,
      }),
    ).resolves.toEqual({ id: expect.any(Number) });

    const row = await repo.getAssertionByKey("agent-1", "state:basis:downgrade:allow");
    expect(row?.basis).toBe("belief");
  });

  it("records grounding metadata in recordJson", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "grounding:record-json",
      settlementId: "settlement-grounding-json",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "tracks grounding",
      entityPointerKeys: ["src", "dst"],
      stance: "accepted",
      basis: "inference",
      provenance: "user_stated",
      claimedGroundingRefs: [
        { kind: "user_message", ref: "request:req-1" },
        { kind: "private_episode", ref: "episode:ep-1" },
      ],
      verifiedGroundingRefs: [{ kind: "user_message", ref: "request:req-1" }],
      groundingVerificationLevel: "context_verified",
    });

    const event = eventRepo.rows.find((row) => row.cognition_key === "grounding:record-json");
    expect(event).toBeDefined();
    const payload = JSON.parse(String(event!.record_json)) as {
      claimedGroundingRefs?: unknown[];
      verifiedGroundingRefs?: unknown[];
      groundingVerificationLevel?: string;
      provenance?: string;
    };
    expect(payload.claimedGroundingRefs).toHaveLength(2);
    expect(payload.verifiedGroundingRefs).toHaveLength(1);
    expect(payload.groundingVerificationLevel).toBe("context_verified");
    expect(payload.provenance).toBe("user_stated");
  });

  it("projection rebuild reproduces verified grounding metadata", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "grounding:replay",
      settlementId: "settlement-grounding-replay",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "initial write",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "belief",
      provenance: "user_stated",
      claimedGroundingRefs: [{ kind: "user_message", ref: "request:req-2" }],
      verifiedGroundingRefs: [],
      groundingVerificationLevel: "unverified",
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "grounding:replay",
      settlementId: "settlement-grounding-replay::verification",
      opIndex: 1,
      holderPointerKey: "src",
      claim: "initial write",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "first_hand",
      provenance: "user_stated",
      claimedGroundingRefs: [{ kind: "user_message", ref: "request:req-2" }],
      verifiedGroundingRefs: [{ kind: "user_message", ref: "request:req-2" }],
      groundingVerificationLevel: "context_verified",
    });

    projectionRepo.state.clear();
    for (const row of eventRepo.rows) {
      await projectionRepo.upsertFromEvent(row);
    }

    const current = await projectionRepo.getCurrent("agent-1", "grounding:replay");
    expect(current).not.toBeNull();
    const record = JSON.parse(current!.record_json) as {
      verifiedGroundingRefs?: unknown[];
      groundingVerificationLevel?: string;
      basis?: string;
    };
    expect(record.verifiedGroundingRefs).toHaveLength(1);
    expect(record.groundingVerificationLevel).toBe("context_verified");
    expect(current!.basis).toBe("first_hand");
  });

  it("verification-upsert remains replay-safe from append-only event history", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "grounding:append-only-replay",
      settlementId: "stl:append-only:1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "initial assertion",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "belief",
      provenance: "user_stated",
      claimedGroundingRefs: [{ kind: "user_message", ref: "request:req-a" }],
      verifiedGroundingRefs: [],
      groundingVerificationLevel: "unverified",
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "grounding:append-only-replay",
      settlementId: "stl:append-only:1:verify",
      opIndex: 1,
      holderPointerKey: "src",
      claim: "initial assertion",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "first_hand",
      provenance: "user_stated",
      claimedGroundingRefs: [{ kind: "user_message", ref: "request:req-a" }],
      verifiedGroundingRefs: [{ kind: "user_message", ref: "request:req-a" }],
      groundingVerificationLevel: "context_verified",
    });

    const sameKeyEvents = eventRepo.rows.filter(
      (row) => row.cognition_key === "grounding:append-only-replay",
    );
    expect(sameKeyEvents).toHaveLength(2);
    const latestEventRecord = parseRowRecordJson(sameKeyEvents[1].record_json);
    expect(Array.isArray(latestEventRecord.verifiedGroundingRefs)).toBe(true);
    expect((latestEventRecord.verifiedGroundingRefs as unknown[]).length).toBe(1);

    projectionRepo.state.clear();
    for (const row of eventRepo.rows) {
      await projectionRepo.upsertFromEvent(row);
    }

    const rebuilt = await projectionRepo.getCurrent(
      "agent-1",
      "grounding:append-only-replay",
    );
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.basis).toBe("first_hand");
    const rebuiltRecord = parseRowRecordJson(rebuilt!.record_json);
    expect(rebuiltRecord.groundingVerificationLevel).toBe("context_verified");
    expect(Array.isArray(rebuiltRecord.verifiedGroundingRefs)).toBe(true);
    expect((rebuiltRecord.verifiedGroundingRefs as unknown[]).length).toBe(1);
  });

  it("verified user_stated assertion can upgrade basis to first_hand", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "verify:user-stated-upgrade",
      settlementId: "stl:user-upgrade:1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "user asserted this",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "belief",
      provenance: "user_stated",
      claimedGroundingRefs: [{ kind: "user_message", ref: "request:req-u1" }],
      verifiedGroundingRefs: [],
      groundingVerificationLevel: "unverified",
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "verify:user-stated-upgrade",
      settlementId: "stl:user-upgrade:1:verify",
      opIndex: 1,
      holderPointerKey: "src",
      claim: "user asserted this",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "first_hand",
      provenance: "user_stated",
      claimedGroundingRefs: [{ kind: "user_message", ref: "request:req-u1" }],
      verifiedGroundingRefs: [{ kind: "user_message", ref: "request:req-u1" }],
      groundingVerificationLevel: "context_verified",
    });

    const current = await projectionRepo.getCurrent("agent-1", "verify:user-stated-upgrade");
    expect(current).not.toBeNull();
    expect(current!.basis).toBe("first_hand");
  });

  it("verified sketch-origin assertion upgrades only to inference (not first_hand)", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "verify:sketch-origin-cap",
      settlementId: "stl:sketch-cap:1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "sketch-origin claim",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "belief",
      provenance: "talker_sketch_explicit",
      claimedGroundingRefs: [{ kind: "user_message", ref: "request:req-s1" }],
      verifiedGroundingRefs: [],
      groundingVerificationLevel: "unverified",
      isThinkerGuardrailPath: true,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "verify:sketch-origin-cap",
      settlementId: "stl:sketch-cap:1:verify",
      opIndex: 1,
      holderPointerKey: "src",
      claim: "sketch-origin claim",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "inference",
      provenance: "talker_sketch_explicit",
      claimedGroundingRefs: [{ kind: "user_message", ref: "request:req-s1" }],
      verifiedGroundingRefs: [{ kind: "user_message", ref: "request:req-s1" }],
      groundingVerificationLevel: "context_verified",
      isThinkerGuardrailPath: true,
    });

    const current = await projectionRepo.getCurrent("agent-1", "verify:sketch-origin-cap");
    expect(current).not.toBeNull();
    expect(current!.basis).toBe("inference");
    expect(current!.basis).not.toBe("first_hand");
  });

  it("verified cognition refs do not launder weak memory into strong trust", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "grounding:no-launder:cognition-only",
      settlementId: "settlement-grounding-no-launder-1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "cognition refs only",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "belief",
      provenance: "thinker_inferred",
      claimedGroundingRefs: [{ kind: "existing_cognition", ref: "cognition:other" }],
      verifiedGroundingRefs: [{ kind: "existing_cognition", ref: "cognition:other" }],
      groundingVerificationLevel: "context_verified",
    });

    const cognitionOnly = await projectionRepo.getCurrent(
      "agent-1",
      "grounding:no-launder:cognition-only",
    );
    expect(cognitionOnly).not.toBeNull();
    const cognitionOnlyRecord = JSON.parse(String(cognitionOnly!.record_json)) as {
      groundingVerificationLevel?: string;
    };
    expect(cognitionOnlyRecord.groundingVerificationLevel).not.toBe("strong_verified");

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "grounding:no-launder:episode",
      settlementId: "settlement-grounding-no-launder-2",
      opIndex: 1,
      holderPointerKey: "src",
      claim: "episode ref present",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "belief",
      provenance: "user_stated",
      claimedGroundingRefs: [{ kind: "private_episode", ref: "episode:ep-local" }],
      verifiedGroundingRefs: [{ kind: "private_episode", ref: "episode:ep-local" }],
      groundingVerificationLevel: "strong_verified",
    });

    const episodeStrong = await projectionRepo.getCurrent(
      "agent-1",
      "grounding:no-launder:episode",
    );
    expect(episodeStrong).not.toBeNull();
    const episodeStrongRecord = JSON.parse(String(episodeStrong!.record_json)) as {
      groundingVerificationLevel?: string;
    };
    expect(episodeStrongRecord.groundingVerificationLevel).toBe("strong_verified");
  });

  it("lower-version replay cannot beat higher-version correction", async () => {
    const projectionRepo = new MockCognitionProjectionRepo();

    const lowVersionEvent: CognitionEventRow = {
      id: 1,
      agent_id: "agent-1",
      cognition_key: "grounding:version-priority",
      kind: "assertion",
      op: "upsert",
      record_json: JSON.stringify({
        holderPointerKey: "src",
        claim: "old",
        entityPointerKeys: ["dst"],
        stance: "accepted",
        basis: "belief",
        sourceTurnVersion: 2,
      }),
      settlement_id: "stl:version-low",
      committed_time: 1_000,
      request_id: "version-low",
      created_at: 1_000,
    };

    const highVersionEvent: CognitionEventRow = {
      ...lowVersionEvent,
      id: 2,
      record_json: JSON.stringify({
        holderPointerKey: "src",
        claim: "new",
        entityPointerKeys: ["dst"],
        stance: "accepted",
        basis: "first_hand",
        sourceTurnVersion: 5,
      }),
      settlement_id: "stl:version-high",
      committed_time: 900,
      request_id: "version-high",
      created_at: 900,
    };

    await projectionRepo.upsertFromEvent(highVersionEvent);
    await projectionRepo.upsertFromEvent(lowVersionEvent);

    const current = await projectionRepo.getCurrent("agent-1", "grounding:version-priority");
    expect(current).not.toBeNull();
    const payload = JSON.parse(String(current!.record_json)) as {
      sourceTurnVersion?: number;
      claim?: string;
    };
    expect(payload.sourceTurnVersion).toBe(5);
    expect(payload.claim).toBe("new");
  });

  it("rejects terminal assertion key reuse", async () => {
    const eventRepo = new MockCognitionEventRepo();
    const projectionRepo = new MockCognitionProjectionRepo();
    const searchRepo = new MockSearchProjectionRepo();

    const repo = new CognitionRepository({
      cognitionProjectionRepo: projectionRepo,
      cognitionEventRepo: eventRepo,
      searchProjectionRepo: searchRepo,
      entityResolver: async () => 1,
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "terminal:key-reuse",
      settlementId: "stl:terminal:1",
      opIndex: 0,
      holderPointerKey: "src",
      claim: "initial",
      entityPointerKeys: ["src"],
      stance: "accepted",
      basis: "belief",
      provenance: "user_stated",
    });

    await repo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "terminal:key-reuse",
      settlementId: "stl:terminal:2",
      opIndex: 1,
      holderPointerKey: "src",
      claim: "terminal",
      entityPointerKeys: ["src"],
      stance: "rejected",
      basis: "belief",
      provenance: "user_stated",
    });

    await expect(
      repo.upsertAssertion({
        agentId: "agent-1",
        cognitionKey: "terminal:key-reuse",
        settlementId: "stl:terminal:3",
        opIndex: 2,
        holderPointerKey: "src",
        claim: "attempt reuse",
        entityPointerKeys: ["src"],
        stance: "accepted",
        basis: "belief",
        provenance: "user_stated",
      }),
    ).rejects.toThrow("terminal assertion keys cannot be reused");
  });
});
