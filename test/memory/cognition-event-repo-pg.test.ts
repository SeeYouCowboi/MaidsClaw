import { describe, expect, it } from "bun:test";
import type {
  CognitionEventAppendParams,
  CognitionEventRow,
} from "../../src/memory/cognition/cognition-event-repo.js";
import type { CognitionEventRepo } from "../../src/storage/domain-repos/contracts/cognition-event-repo.js";

/**
 * Mock implementation of CognitionEventRepo for unit testing.
 * This mocks the interface without using real PostgreSQL.
 */
class MockCognitionEventRepo implements CognitionEventRepo {
  private nextId = 1;
  private readonly rows: CognitionEventRow[] = [];

  async append(params: CognitionEventAppendParams): Promise<number> {
    const id = this.nextId++;
    const row: CognitionEventRow = {
      id,
      agent_id: params.agentId,
      cognition_key: params.cognitionKey,
      kind: params.kind,
      op: params.op,
      record_json: params.recordJson,
      settlement_id: params.settlementId,
      committed_time: params.committedTime,
      created_at: Date.now(),
    };
    this.rows.push(row);
    return id;
  }

  async readByAgent(agentId: string, limit?: number): Promise<CognitionEventRow[]> {
    const filtered = this.rows.filter((row) => row.agent_id === agentId);
    const effectiveLimit = limit ?? 500;
    return filtered.slice(0, effectiveLimit);
  }

  async readByCognitionKey(agentId: string, cognitionKey: string): Promise<CognitionEventRow[]> {
    return this.rows.filter(
      (row) => row.agent_id === agentId && row.cognition_key === cognitionKey,
    );
  }

  async replay(agentId: string, afterTime?: number): Promise<CognitionEventRow[]> {
    let filtered = this.rows.filter((row) => row.agent_id === agentId);
    if (afterTime !== undefined) {
      filtered = filtered.filter((row) => row.committed_time > afterTime);
    }
    return filtered.sort((a, b) => a.committed_time - b.committed_time || a.id - b.id);
  }

  // Test helpers
  getAllRows(): CognitionEventRow[] {
    return [...this.rows];
  }

  clear(): void {
    this.rows.length = 0;
    this.nextId = 1;
  }
}

describe("CognitionEventRepo (interface mock)", () => {
  describe("append", () => {
    it("returns an event ID", async () => {
      const repo: CognitionEventRepo = new MockCognitionEventRepo();

      const eventId = await repo.append({
        agentId: "agent-1",
        cognitionKey: "test:key",
        kind: "assertion",
        op: "upsert",
        recordJson: JSON.stringify({ test: true }),
        settlementId: "settlement-1",
        committedTime: Date.now(),
      });

      expect(eventId).toBeGreaterThan(0);
      expect(typeof eventId).toBe("number");
    });

    it("returns incrementing event IDs", async () => {
      const repo: CognitionEventRepo = new MockCognitionEventRepo();

      const id1 = await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:1",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-1",
        committedTime: Date.now(),
      });

      const id2 = await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:2",
        kind: "evaluation",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-2",
        committedTime: Date.now(),
      });

      expect(id2).toBe(id1 + 1);
    });
  });

  describe("readByAgent", () => {
    it("returns events for an agent", async () => {
      const repo = new MockCognitionEventRepo();
      const now = Date.now();

      // Add events for agent-1
      await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:a",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-1",
        committedTime: now,
      });

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:b",
        kind: "commitment",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-2",
        committedTime: now + 1,
      });

      // Add event for agent-2
      await repo.append({
        agentId: "agent-2",
        cognitionKey: "key:c",
        kind: "evaluation",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-3",
        committedTime: now + 2,
      });

      const agent1Events = await repo.readByAgent("agent-1");

      expect(agent1Events).toHaveLength(2);
      expect(agent1Events[0].agent_id).toBe("agent-1");
      expect(agent1Events[1].agent_id).toBe("agent-1");
    });

    it("returns empty array when no events exist for agent", async () => {
      const repo: CognitionEventRepo = new MockCognitionEventRepo();

      const events = await repo.readByAgent("nonexistent-agent");

      expect(events).toEqual([]);
    });

    it("respects limit parameter", async () => {
      const repo = new MockCognitionEventRepo();
      const now = Date.now();

      // Add 5 events for agent-1
      for (let i = 0; i < 5; i++) {
        await repo.append({
          agentId: "agent-1",
          cognitionKey: `key:${i}`,
          kind: "assertion",
          op: "upsert",
          recordJson: null,
          settlementId: `settlement-${i}`,
          committedTime: now + i,
        });
      }

      const events = await repo.readByAgent("agent-1", 3);

      expect(events).toHaveLength(3);
    });
  });

  describe("readByCognitionKey", () => {
    it("returns events for a specific key", async () => {
      const repo = new MockCognitionEventRepo();
      const now = Date.now();

      // Add events with different keys
      await repo.append({
        agentId: "agent-1",
        cognitionKey: "target:key",
        kind: "assertion",
        op: "upsert",
        recordJson: JSON.stringify({ value: 1 }),
        settlementId: "settlement-1",
        committedTime: now,
      });

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "other:key",
        kind: "assertion",
        op: "upsert",
        recordJson: JSON.stringify({ value: 2 }),
        settlementId: "settlement-2",
        committedTime: now + 1,
      });

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "target:key",
        kind: "assertion",
        op: "retract",
        recordJson: null,
        settlementId: "settlement-3",
        committedTime: now + 2,
      });

      const targetEvents = await repo.readByCognitionKey("agent-1", "target:key");

      expect(targetEvents).toHaveLength(2);
      expect(targetEvents[0].cognition_key).toBe("target:key");
      expect(targetEvents[1].cognition_key).toBe("target:key");
      expect(targetEvents[0].op).toBe("upsert");
      expect(targetEvents[1].op).toBe("retract");
    });

    it("filters by both agent and cognition key", async () => {
      const repo = new MockCognitionEventRepo();
      const now = Date.now();

      // Same key, different agents
      await repo.append({
        agentId: "agent-1",
        cognitionKey: "shared:key",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-1",
        committedTime: now,
      });

      await repo.append({
        agentId: "agent-2",
        cognitionKey: "shared:key",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-2",
        committedTime: now + 1,
      });

      const agent1Events = await repo.readByCognitionKey("agent-1", "shared:key");

      expect(agent1Events).toHaveLength(1);
      expect(agent1Events[0].agent_id).toBe("agent-1");
    });

    it("returns empty array when key not found", async () => {
      const repo: CognitionEventRepo = new MockCognitionEventRepo();

      const events = await repo.readByCognitionKey("agent-1", "nonexistent:key");

      expect(events).toEqual([]);
    });
  });

  describe("replay", () => {
    it("returns all events for agent ordered by committed_time", async () => {
      const repo = new MockCognitionEventRepo();

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:1",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-1",
        committedTime: 3000,
      });

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:2",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-2",
        committedTime: 1000,
      });

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:3",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-3",
        committedTime: 2000,
      });

      const events = await repo.replay("agent-1");

      expect(events).toHaveLength(3);
      expect(events[0].committed_time).toBe(1000);
      expect(events[1].committed_time).toBe(2000);
      expect(events[2].committed_time).toBe(3000);
    });

    it("filters by afterTime when provided", async () => {
      const repo = new MockCognitionEventRepo();

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:1",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-1",
        committedTime: 1000,
      });

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:2",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-2",
        committedTime: 2000,
      });

      await repo.append({
        agentId: "agent-1",
        cognitionKey: "key:3",
        kind: "assertion",
        op: "upsert",
        recordJson: null,
        settlementId: "settlement-3",
        committedTime: 3000,
      });

      const events = await repo.replay("agent-1", 1500);

      expect(events).toHaveLength(2);
      expect(events[0].committed_time).toBe(2000);
      expect(events[1].committed_time).toBe(3000);
    });
  });
});
