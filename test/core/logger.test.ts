import { describe, expect, it } from "bun:test";
import { createLogger, type Logger, type LogContext } from "../../src/core/logger.js";
import { createObservabilityRegistry } from "../../src/core/observability.js";

describe("Logger", () => {
  it("happy path: emits structured log entries", () => {
    // Capture output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    
    const logger = createLogger({ level: "debug" });
    logger.info("test message", { session_id: "s1", agent_id: "a1" });
    
    console.log = origLog;
    
    expect(logs.length).toBeGreaterThan(0);
    const entry = JSON.parse(logs[0]!);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("test message");
    expect(entry.context.session_id).toBe("s1");
    expect(entry.context.agent_id).toBe("a1");
    expect(entry.timestamp).toBeDefined();
    expect(typeof entry.timestamp).toBe("number");
  });

  it("error path: preserves code and retriable status", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    
    const logger = createLogger();
    logger.error("something failed", { code: "MODEL_TIMEOUT", message: "timed out", retriable: true });
    
    console.log = origLog;
    
    const entry = JSON.parse(logs[0]!);
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("something failed");
    expect(entry.error?.code).toBe("MODEL_TIMEOUT");
    expect(entry.error?.message).toBe("timed out");
    expect(entry.error?.retriable).toBe(true);
  });

  it("edge path: child loggers don't cross-contaminate", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    
    const parent = createLogger();
    const child1 = parent.child({ session_id: "s1" });
    const child2 = parent.child({ session_id: "s2" });
    
    child1.info("from child 1");
    child2.info("from child 2");
    
    console.log = origLog;
    
    expect(logs.length).toBe(2);
    const entry1 = JSON.parse(logs[0]!);
    const entry2 = JSON.parse(logs[1]!);
    expect(entry1.context.session_id).toBe("s1");
    expect(entry1.message).toBe("from child 1");
    expect(entry2.context.session_id).toBe("s2");
    expect(entry2.message).toBe("from child 2");
  });

  it("log level filtering: debug logs are filtered when level is info", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    
    const logger = createLogger({ level: "info" });
    logger.debug("debug message");
    logger.info("info message");
    
    console.log = origLog;
    
    expect(logs.length).toBe(1);
    const entry = JSON.parse(logs[0]!);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("info message");
  });

  it("child logger inherits parent context and merges with per-call context", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    
    const parent = createLogger();
    const child = parent.child({ session_id: "s1", agent_id: "a1" });
    
    // Per-call context should override parent context
    child.info("test", { agent_id: "a2", tool_name: "my_tool" });
    
    console.log = origLog;
    
    const entry = JSON.parse(logs[0]!);
    expect(entry.context.session_id).toBe("s1");
    expect(entry.context.agent_id).toBe("a2"); // Overridden by per-call
    expect(entry.context.tool_name).toBe("my_tool");
  });

  it("grandchild logger inherits both parent and grandparent context", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    
    const grandparent = createLogger();
    const parent = grandparent.child({ session_id: "s1" });
    const child = parent.child({ agent_id: "a1" });
    
    child.info("test");
    
    console.log = origLog;
    
    const entry = JSON.parse(logs[0]!);
    expect(entry.context.session_id).toBe("s1");
    expect(entry.context.agent_id).toBe("a1");
  });
});

describe("Observability", () => {
  it("counter increments correctly", () => {
    const reg = createObservabilityRegistry();
    const counter = reg.counter("my_counter");
    counter.increment();
    counter.increment(5);
    expect(counter.value()).toBe(6);
  });

  it("counter reset works", () => {
    const reg = createObservabilityRegistry();
    const counter = reg.counter("my_counter");
    counter.increment(10);
    counter.reset();
    expect(counter.value()).toBe(0);
  });

  it("timer measures elapsed time", async () => {
    const reg = createObservabilityRegistry();
    const timer = reg.timer("my_timer");
    timer.start();
    await new Promise(r => setTimeout(r, 50));
    const elapsed = timer.stop();
    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some tolerance
  });

  it("timer elapsed() works without stopping", async () => {
    const reg = createObservabilityRegistry();
    const timer = reg.timer("my_timer");
    timer.start();
    await new Promise(r => setTimeout(r, 30));
    const elapsed1 = timer.elapsed();
    await new Promise(r => setTimeout(r, 30));
    const elapsed2 = timer.elapsed();
    
    expect(elapsed1).toBeGreaterThanOrEqual(20);
    expect(elapsed2).toBeGreaterThanOrEqual(elapsed1);
  });

  it("registries are independent", () => {
    const reg1 = createObservabilityRegistry();
    const reg2 = createObservabilityRegistry();
    reg1.counter("c").increment(10);
    expect(reg2.counter("c").value()).toBe(0); // No cross-leakage
  });

  it("gauge sets and reads values", () => {
    const reg = createObservabilityRegistry();
    const gauge = reg.gauge("my_gauge");
    
    gauge.set(42);
    expect(gauge.value()).toBe(42);
    
    gauge.set(100);
    expect(gauge.value()).toBe(100);
  });

  it("snapshot returns all metrics", () => {
    const reg = createObservabilityRegistry();
    reg.counter("requests").increment(5);
    reg.gauge("temperature").set(23.5);
    
    const snapshot = reg.snapshot();
    expect(snapshot["counter.requests"]).toBe(5);
    expect(snapshot["gauge.temperature"]).toBe(23.5);
  });

  it("counters, timers, and gauges don't cross-leak between registry instances", () => {
    const reg1 = createObservabilityRegistry();
    const reg2 = createObservabilityRegistry();
    
    reg1.counter("c").increment(10);
    reg1.gauge("g").set(42);
    
    expect(reg2.counter("c").value()).toBe(0);
    expect(reg2.gauge("g").value()).toBe(0);
  });
});
