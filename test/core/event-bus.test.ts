import { describe, expect, it } from "bun:test";
import { createEventBus } from "../../src/core/event-bus.js";
import type { EventBus } from "../../src/core/event-bus.js";

describe("EventBus", () => {
  it("happy path: emits typed payloads to subscribers", () => {
    const bus = createEventBus();
    const received: string[] = [];
    
    bus.on("session.closed", (payload) => {
      received.push(payload.sessionId);
    });
    
    bus.emit("session.closed", { sessionId: "s1", reason: "explicit" });
    bus.emit("session.closed", { sessionId: "s2", reason: "idle_timeout" });
    
    expect(received).toEqual(["s1", "s2"]);
  });

  it("error path: throwing listener logs error and continues", () => {
    const errors: string[] = [];
    // Mock logger
    const mockLogger: {
      error: (msg: string, err?: unknown) => void;
      debug: () => void;
      info: () => void;
      warn: () => void;
      child: () => typeof mockLogger;
    } = {
      error: (msg: string, err?: unknown) => { errors.push(msg); },
      debug: () => {},
      info: () => {},
      warn: () => {},
      child: (): typeof mockLogger => mockLogger,
    };
    const bus = createEventBus(mockLogger as unknown as Parameters<typeof createEventBus>[0]);
    
    const results: string[] = [];
    bus.on("session.closed", (_p) => { throw new Error("listener error"); });
    bus.on("session.closed", (p) => { results.push(p.sessionId); });
    
    bus.emit("session.closed", { sessionId: "s1", reason: "explicit" });
    
    expect(errors.length).toBeGreaterThan(0);
    expect(results).toEqual(["s1"]); // Second listener still ran
  });

  it("edge path: once listener self-removes after first emit", () => {
    const bus = createEventBus();
    let count = 0;
    
    bus.once("session.closed", (_p) => { count++; });
    
    bus.emit("session.closed", { sessionId: "s1", reason: "explicit" });
    bus.emit("session.closed", { sessionId: "s2", reason: "explicit" });
    
    expect(count).toBe(1); // Only called once
  });

  it("unsubscribe removes the listener", () => {
    const bus = createEventBus();
    let count = 0;
    
    const unsub = bus.on("session.closed", (_p) => { count++; });
    bus.emit("session.closed", { sessionId: "s1", reason: "explicit" });
    unsub();
    bus.emit("session.closed", { sessionId: "s2", reason: "explicit" });
    
    expect(count).toBe(1);
  });

  it("off removes specific handler by reference", () => {
    const bus = createEventBus();
    let count1 = 0;
    let count2 = 0;
    
    const h1 = (_p: unknown) => { count1++; };
    const h2 = (_p: unknown) => { count2++; };
    
    bus.on("session.closed", h1);
    bus.on("session.closed", h2);
    bus.off("session.closed", h1);
    
    bus.emit("session.closed", { sessionId: "s1", reason: "explicit" });
    
    expect(count1).toBe(0);
    expect(count2).toBe(1);
  });

  it("multiple event types don't interfere", () => {
    const bus = createEventBus();
    const sessionEvents: string[] = [];
    const mcpEvents: string[] = [];
    
    bus.on("session.closed", p => { sessionEvents.push(p.sessionId); });
    bus.on("mcp.connected", p => { mcpEvents.push(p.serverId); });
    
    bus.emit("session.closed", { sessionId: "s1", reason: "explicit" });
    bus.emit("mcp.connected", { serverId: "mcp1", serverName: "test" });
    
    expect(sessionEvents).toEqual(["s1"]);
    expect(mcpEvents).toEqual(["mcp1"]);
  });
});
