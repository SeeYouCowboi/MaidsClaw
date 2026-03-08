import { describe, expect, it, beforeEach } from "bun:test";
import { MaidsClawError } from "../../src/core/errors.js";
import { Blackboard } from "../../src/state/blackboard.js";
import {
  V1_NAMESPACES,
  ACTIVE_PREFIXES,
  RESERVED_PREFIXES,
  resolveNamespace,
} from "../../src/state/namespaces.js";
import {
  setAgentLocation,
  getAgentLocation,
  setObjectLocation,
  getObjectLocation,
} from "../../src/state/location-helpers.js";

// ---------------------------------------------------------------------------
// Namespace definitions
// ---------------------------------------------------------------------------

describe("Namespaces", () => {
  it("V1 defines exactly 6 namespaces (5 active + 1 reserved)", () => {
    expect(V1_NAMESPACES.length).toBe(6);
  });

  it("ACTIVE_PREFIXES contains exactly 5 entries", () => {
    expect(ACTIVE_PREFIXES.size).toBe(5);
    expect(ACTIVE_PREFIXES.has("session.")).toBe(true);
    expect(ACTIVE_PREFIXES.has("delegation.")).toBe(true);
    expect(ACTIVE_PREFIXES.has("task.")).toBe(true);
    expect(ACTIVE_PREFIXES.has("agent_runtime.")).toBe(true);
    expect(ACTIVE_PREFIXES.has("transport.")).toBe(true);
  });

  it("RESERVED_PREFIXES contains only autonomy.*", () => {
    expect(RESERVED_PREFIXES.size).toBe(1);
    expect(RESERVED_PREFIXES.has("autonomy.")).toBe(true);
  });

  it("resolveNamespace returns definition for known key", () => {
    const ns = resolveNamespace("session.active_id");
    expect(ns).toBeDefined();
    expect(ns!.prefix).toBe("session.");
    expect(ns!.owner).toBe("T27a");
  });

  it("resolveNamespace returns undefined for unknown prefix", () => {
    expect(resolveNamespace("unknown.key")).toBeUndefined();
    expect(resolveNamespace("")).toBeUndefined();
    expect(resolveNamespace("sessions.typo")).toBeUndefined();
  });

  it("resolveNamespace returns reserved definition for autonomy.*", () => {
    const ns = resolveNamespace("autonomy.some_key");
    expect(ns).toBeDefined();
    expect(ns!.reserved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Blackboard — core operations
// ---------------------------------------------------------------------------

describe("Blackboard", () => {
  let bb: Blackboard;

  beforeEach(() => {
    bb = new Blackboard();
  });

  // --- Happy path: basic set/get/delete ---

  describe("basic set / get / delete", () => {
    it("set and get a session key (single-writer: system)", () => {
      bb.set("session.id", "abc-123", "system");
      expect(bb.get("session.id")).toBe("abc-123");
    });

    it("set and get a delegation key (single-writer: maiden)", () => {
      bb.set("delegation.current", { agentId: "maid:rp1" }, "maiden");
      const val = bb.get("delegation.current") as { agentId: string };
      expect(val.agentId).toBe("maid:rp1");
    });

    it("set and get a task key (open writer)", () => {
      bb.set("task.job1.status", "running");
      expect(bb.get("task.job1.status")).toBe("running");
    });

    it("set and get an agent_runtime key (open writer)", () => {
      bb.set("agent_runtime.heartbeat.agent1", Date.now());
      expect(typeof bb.get("agent_runtime.heartbeat.agent1")).toBe("number");
    });

    it("set and get a transport key (single-writer: gateway)", () => {
      bb.set("transport.connected", true, "gateway");
      expect(bb.get("transport.connected")).toBe(true);
    });

    it("get returns undefined for non-existent key", () => {
      expect(bb.get("session.nope")).toBeUndefined();
    });

    it("has returns true for existing key, false for missing", () => {
      bb.set("task.foo", "bar");
      expect(bb.has("task.foo")).toBe(true);
      expect(bb.has("task.baz")).toBe(false);
    });

    it("delete removes a key", () => {
      bb.set("task.temp", 42);
      expect(bb.has("task.temp")).toBe(true);
      const deleted = bb.delete("task.temp");
      expect(deleted).toBe(true);
      expect(bb.has("task.temp")).toBe(false);
    });

    it("delete returns false for non-existent key", () => {
      expect(bb.delete("task.nonexistent")).toBe(false);
    });

    it("size tracks entries correctly", () => {
      expect(bb.size).toBe(0);
      bb.set("task.a", 1);
      bb.set("task.b", 2);
      expect(bb.size).toBe(2);
      bb.delete("task.a");
      expect(bb.size).toBe(1);
    });

    it("clear removes all entries", () => {
      bb.set("task.x", 1);
      bb.set("agent_runtime.y", 2);
      bb.clear();
      expect(bb.size).toBe(0);
    });

    it("keys returns snapshot of all keys", () => {
      bb.set("task.a", 1);
      bb.set("session.b", "v", "system");
      const keys = bb.keys();
      expect(keys.length).toBe(2);
      expect(keys).toContain("task.a");
      expect(keys).toContain("session.b");
    });
  });

  // --- Last-write-wins semantics ---

  describe("last-write-wins semantics", () => {
    it("session.* overwrites on repeated set", () => {
      bb.set("session.turn_count", 1, "system");
      bb.set("session.turn_count", 2, "system");
      expect(bb.get("session.turn_count")).toBe(2);
    });

    it("agent_runtime.* overwrites on repeated set", () => {
      bb.set("agent_runtime.status.agent1", "idle");
      bb.set("agent_runtime.status.agent1", "running");
      expect(bb.get("agent_runtime.status.agent1")).toBe("running");
    });

    it("transport.* overwrites on repeated set", () => {
      bb.set("transport.last_ping", 100, "gateway");
      bb.set("transport.last_ping", 200, "gateway");
      expect(bb.get("transport.last_ping")).toBe(200);
    });
  });

  // --- getNamespace ---

  describe("getNamespace", () => {
    it("returns all keys under a given prefix", () => {
      bb.set("task.job1.status", "done");
      bb.set("task.job2.status", "pending");
      bb.set("session.id", "sess1", "system");

      const taskEntries = bb.getNamespace("task.");
      expect(Object.keys(taskEntries).length).toBe(2);
      expect(taskEntries["task.job1.status"]).toBe("done");
      expect(taskEntries["task.job2.status"]).toBe("pending");
    });

    it("returns empty object when no keys match", () => {
      bb.set("task.a", 1);
      const result = bb.getNamespace("delegation.");
      expect(Object.keys(result).length).toBe(0);
    });
  });

  // --- Namespace validation: invalid prefix ---

  describe("invalid namespace rejection", () => {
    it("rejects key with no known prefix", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("unknown.key", "value");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_INVALID_NAMESPACE");
    });

    it("rejects empty key", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("", "value");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_INVALID_NAMESPACE");
    });

    it("rejects key that is close but not matching (typo)", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("sessions.id", "value");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_INVALID_NAMESPACE");
    });

    it("rejects delete on invalid namespace", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.delete("unknown.key");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_INVALID_NAMESPACE");
    });
  });

  // --- Reserved namespace: autonomy.* ---

  describe("reserved namespace (autonomy.*) rejection", () => {
    it("rejects set on autonomy.* key", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("autonomy.cron.schedule", "daily");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_NAMESPACE_RESERVED");
    });

    it("rejects delete on autonomy.* key", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.delete("autonomy.some_key");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_NAMESPACE_RESERVED");
    });
  });

  // --- Ownership enforcement ---

  describe("ownership enforcement", () => {
    it("session.* rejects write from non-system caller", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("session.id", "abc", "rogue_agent");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_OWNERSHIP_VIOLATION");
    });

    it("session.* rejects write with no caller", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("session.id", "abc");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_OWNERSHIP_VIOLATION");
    });

    it("delegation.* rejects write from non-maiden caller", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("delegation.active", "something", "agent_loop");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_OWNERSHIP_VIOLATION");
    });

    it("transport.* rejects write from non-gateway caller", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("transport.ws_state", "open", "agent");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_OWNERSHIP_VIOLATION");
    });

    it("task.* allows write from any caller (open writer)", () => {
      // Should not throw — task.* has singleWriter=null
      bb.set("task.job.status", "running", "worker_1");
      expect(bb.get("task.job.status")).toBe("running");
    });

    it("agent_runtime.* allows write from any caller (open writer)", () => {
      bb.set("agent_runtime.active_job", "job123", "agent_loop");
      expect(bb.get("agent_runtime.active_job")).toBe("job123");
    });

    it("delete on session.* rejects non-system caller", () => {
      bb.set("session.temp", "v", "system");
      let caught: MaidsClawError | undefined;
      try {
        bb.delete("session.temp", "other");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe("BLACKBOARD_OWNERSHIP_VIOLATION");
    });
  });

  // --- Error properties ---

  describe("error properties", () => {
    it("BLACKBOARD_INVALID_NAMESPACE is not retriable", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("nope.key", "v");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught!.retriable).toBe(false);
    });

    it("BLACKBOARD_NAMESPACE_RESERVED is not retriable", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("autonomy.x", "v");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught!.retriable).toBe(false);
    });

    it("BLACKBOARD_OWNERSHIP_VIOLATION includes details", () => {
      let caught: MaidsClawError | undefined;
      try {
        bb.set("session.x", "v", "wrong");
      } catch (err) {
        caught = err as MaidsClawError;
      }
      expect(caught!.retriable).toBe(false);
      const details = caught!.details as {
        expectedCaller: string;
        actualCaller: string;
      };
      expect(details.expectedCaller).toBe("system");
      expect(details.actualCaller).toBe("wrong");
    });
  });
});

// ---------------------------------------------------------------------------
// Location helpers
// ---------------------------------------------------------------------------

describe("Location helpers", () => {
  let bb: Blackboard;

  beforeEach(() => {
    bb = new Blackboard();
  });

  describe("agent location", () => {
    it("set and get agent location", () => {
      setAgentLocation(bb, "maid:rp1", 42);
      expect(getAgentLocation(bb, "maid:rp1")).toBe(42);
    });

    it("returns undefined when no location set", () => {
      expect(getAgentLocation(bb, "maid:rp1")).toBeUndefined();
    });

    it("overwrites previous location (last-write-wins)", () => {
      setAgentLocation(bb, "maid:rp1", 10);
      setAgentLocation(bb, "maid:rp1", 20);
      expect(getAgentLocation(bb, "maid:rp1")).toBe(20);
    });

    it("different agents have independent locations", () => {
      setAgentLocation(bb, "maid:rp1", 100);
      setAgentLocation(bb, "maid:rp2", 200);
      expect(getAgentLocation(bb, "maid:rp1")).toBe(100);
      expect(getAgentLocation(bb, "maid:rp2")).toBe(200);
    });

    it("uses agent_runtime namespace (visible in getNamespace)", () => {
      setAgentLocation(bb, "maid:main", 5);
      const ns = bb.getNamespace("agent_runtime.");
      expect(ns["agent_runtime.location.maid:main"]).toBe(5);
    });
  });

  describe("object location", () => {
    it("set and get object location", () => {
      setObjectLocation(bb, "sword_001", 99);
      expect(getObjectLocation(bb, "sword_001")).toBe(99);
    });

    it("returns undefined when no location set", () => {
      expect(getObjectLocation(bb, "shield_002")).toBeUndefined();
    });

    it("overwrites previous location (last-write-wins)", () => {
      setObjectLocation(bb, "key_003", 1);
      setObjectLocation(bb, "key_003", 2);
      expect(getObjectLocation(bb, "key_003")).toBe(2);
    });

    it("different objects have independent locations", () => {
      setObjectLocation(bb, "obj_a", 10);
      setObjectLocation(bb, "obj_b", 20);
      expect(getObjectLocation(bb, "obj_a")).toBe(10);
      expect(getObjectLocation(bb, "obj_b")).toBe(20);
    });

    it("uses agent_runtime.location.obj: key pattern", () => {
      setObjectLocation(bb, "chest_01", 77);
      const ns = bb.getNamespace("agent_runtime.location.obj:");
      expect(ns["agent_runtime.location.obj:chest_01"]).toBe(77);
    });
  });

  describe("agent and object locations coexist", () => {
    it("agent and object locations do not collide", () => {
      setAgentLocation(bb, "agent1", 10);
      setObjectLocation(bb, "agent1", 20); // same ID, different key pattern
      expect(getAgentLocation(bb, "agent1")).toBe(10);
      expect(getObjectLocation(bb, "agent1")).toBe(20);
    });
  });
});
