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
      const sourcePointerKey = typeof parsed.sourcePointerKey === "string" ? parsed.sourcePointerKey : "?";
      const predicate = typeof parsed.predicate === "string" ? parsed.predicate : null;
      const targetPointerKey = typeof parsed.targetPointerKey === "string" ? parsed.targetPointerKey : "?";
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
    _scope: "private" | "area" | "world",
    _sourceRef: NodeRef,
    _content: string,
    _agentId?: string,
    _locationEntityId?: number,
  ): Promise<number> {
    return 0;
  }

  async removeSearchDoc(_scope: "private" | "area" | "world", _sourceRef: NodeRef): Promise<void> {}

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
      entityPointerKeys: ["pointer:shared", "pointer:target"],
      stance: "accepted",
      basis: "first_hand",
    });

    const row = await repo.getAssertionByKey("agent-1", "resolve:key");
    expect(row).not.toBeNull();
    expect(row!.sourceEntityId).toBe(999);
    expect(row!.targetEntityId).toBe(202);
    expect(resolverCalls).toEqual([
      { pointerKey: "pointer:shared", agentId: "agent-1" },
      { pointerKey: "pointer:shared", agentId: "agent-1" },
      { pointerKey: "pointer:target", agentId: "agent-1" },
      { pointerKey: "pointer:shared", agentId: "agent-1" },
      { pointerKey: "pointer:shared", agentId: "agent-1" },
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
});
