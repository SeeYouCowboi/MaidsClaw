import { describe, expect, it } from "bun:test";
import {
  type SessionRecord,
  SessionService,
} from "../../src/session/service.js";

function seedSessions(service: SessionService): void {
  const state = service as unknown as {
    sessions: Map<string, SessionRecord>;
    recoveryRequired: Set<string>;
  };

  state.sessions.set("sess-d", {
    sessionId: "sess-d",
    agentId: "agent-a",
    createdAt: 400,
  });
  state.sessions.set("sess-c", {
    sessionId: "sess-c",
    agentId: "agent-a",
    createdAt: 400,
    closedAt: 450,
  });
  state.sessions.set("sess-b", {
    sessionId: "sess-b",
    agentId: "agent-b",
    createdAt: 300,
  });
  state.sessions.set("sess-a", {
    sessionId: "sess-a",
    agentId: "agent-a",
    createdAt: 200,
    closedAt: 250,
  });

  state.recoveryRequired.add("sess-c");
  state.recoveryRequired.add("sess-b");
}

describe("SessionService.listSessions (in-memory)", () => {
  it("orders by created_at DESC then session_id DESC with status precedence", async () => {
    const service = new SessionService();
    seedSessions(service);

    const result = await service.listSessions({ limit: 10 });
    expect(result.nextCursor).toBeNull();
    expect(result.items.map((item) => item.session_id)).toEqual([
      "sess-d",
      "sess-c",
      "sess-b",
      "sess-a",
    ]);
    expect(result.items.map((item) => item.status)).toEqual([
      "open",
      "recovery_required",
      "recovery_required",
      "closed",
    ]);
  });

  it("applies filters with consistent status semantics", async () => {
    const service = new SessionService();
    seedSessions(service);

    const byAgent = await service.listSessions({ agentId: "agent-a", limit: 10 });
    expect(byAgent.items.map((item) => item.session_id)).toEqual([
      "sess-d",
      "sess-c",
      "sess-a",
    ]);

    const closedOnly = await service.listSessions({ status: "closed", limit: 10 });
    expect(closedOnly.items.map((item) => item.session_id)).toEqual(["sess-a"]);

    const recoveryOnly = await service.listSessions({ status: "recovery_required", limit: 10 });
    expect(recoveryOnly.items.map((item) => item.session_id)).toEqual([
      "sess-c",
      "sess-b",
    ]);
  });

  it("supports cursor pagination without overlaps", async () => {
    const service = new SessionService();
    seedSessions(service);

    const page1 = await service.listSessions({ limit: 2 });
    expect(page1.items.map((item) => item.session_id)).toEqual([
      "sess-d",
      "sess-c",
    ]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await service.listSessions({
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.map((item) => item.session_id)).toEqual([
      "sess-b",
      "sess-a",
    ]);
    expect(page2.nextCursor).toBeNull();
  });
});
