import { describe, expect, it } from "bun:test";
import { VisibilityPolicy } from "./visibility-policy";
import { getDefaultPermissions, hasAdminReadAccess } from "./contracts/agent-permissions";
import type { ViewerContext } from "./types";

function makeViewer(overrides?: Partial<ViewerContext>): ViewerContext {
  return {
    viewer_agent_id: "agent-1",
    viewer_role: "rp_agent",
    current_area_id: 100,
    session_id: "sess-1",
    ...overrides,
  };
}

describe("VisibilityPolicy", () => {
  const policy = new VisibilityPolicy();

  // ── isEventVisible ────────────────────────────────────────────────

  describe("isEventVisible", () => {
    it("returns true for world_public events", () => {
      const viewer = makeViewer();
      expect(policy.isEventVisible(viewer, { visibility_scope: "world_public", location_entity_id: 999 })).toBe(true);
    });

    it("returns true for area_visible events when viewer is in same area", () => {
      const viewer = makeViewer({ current_area_id: 42 });
      expect(policy.isEventVisible(viewer, { visibility_scope: "area_visible", location_entity_id: 42 })).toBe(true);
    });

    it("returns false for area_visible events when viewer is in different area", () => {
      const viewer = makeViewer({ current_area_id: 42 });
      expect(policy.isEventVisible(viewer, { visibility_scope: "area_visible", location_entity_id: 99 })).toBe(false);
    });

    it("returns false for system_only events", () => {
      const viewer = makeViewer();
      expect(policy.isEventVisible(viewer, { visibility_scope: "system_only", location_entity_id: 100 })).toBe(false);
    });

    it("returns false for owner_private events", () => {
      const viewer = makeViewer();
      expect(policy.isEventVisible(viewer, { visibility_scope: "owner_private", location_entity_id: 100 })).toBe(false);
    });
  });

  // ── isEntityVisible ───────────────────────────────────────────────

  describe("isEntityVisible", () => {
    it("returns true for shared_public entities", () => {
      const viewer = makeViewer();
      expect(policy.isEntityVisible(viewer, { memory_scope: "shared_public", owner_agent_id: null })).toBe(true);
    });

    it("returns true for private_overlay entities when viewer is owner", () => {
      const viewer = makeViewer({ viewer_agent_id: "agent-1" });
      expect(policy.isEntityVisible(viewer, { memory_scope: "private_overlay", owner_agent_id: "agent-1" })).toBe(true);
    });

    it("returns false for private_overlay entities when viewer is not owner", () => {
      const viewer = makeViewer({ viewer_agent_id: "agent-1" });
      expect(policy.isEntityVisible(viewer, { memory_scope: "private_overlay", owner_agent_id: "agent-2" })).toBe(false);
    });

    it("returns false for unknown memory_scope", () => {
      const viewer = makeViewer();
      expect(policy.isEntityVisible(viewer, { memory_scope: "unknown_scope", owner_agent_id: null })).toBe(false);
    });
  });

  // ── isFactVisible ────────────────────────────────────────────────

  describe("isFactVisible", () => {
    it("always returns true (facts are world_public)", () => {
      const viewer = makeViewer();
      expect(policy.isFactVisible(viewer)).toBe(true);
    });
  });

  // ── isPrivateNodeVisible ─────────────────────────────────────────

  describe("isPrivateNodeVisible", () => {
    it("returns true when agent_id matches viewer", () => {
      const viewer = makeViewer({ viewer_agent_id: "agent-1" });
      expect(policy.isPrivateNodeVisible(viewer, { agent_id: "agent-1" })).toBe(true);
    });

    it("returns false when agent_id does not match viewer", () => {
      const viewer = makeViewer({ viewer_agent_id: "agent-1" });
      expect(policy.isPrivateNodeVisible(viewer, { agent_id: "agent-2" })).toBe(false);
    });
  });

  // ── isNodeVisible (dispatch) ─────────────────────────────────────

  describe("isNodeVisible", () => {
    it("returns admin_only for non-admin and visible for admin on system_only events", () => {
      const event = { visibility_scope: "system_only", location_entity_id: 100, owner_agent_id: null };
      const rpViewer = makeViewer({ viewer_role: "rp_agent" });
      const maidenViewer = makeViewer({ viewer_role: "maiden" });

      expect(hasAdminReadAccess(getDefaultPermissions(rpViewer.viewer_agent_id, rpViewer.viewer_role))).toBe(false);
      expect(policy.getNodeDisposition(rpViewer, "event:99", event)).toBe("admin_only");

      expect(hasAdminReadAccess(getDefaultPermissions(maidenViewer.viewer_agent_id, maidenViewer.viewer_role))).toBe(true);
      expect(policy.getNodeDisposition(maidenViewer, "event:99", event)).toBe("visible");
    });

    it("dispatches event: refs to isEventVisible", () => {
      const viewer = makeViewer({ current_area_id: 50 });
      expect(policy.isNodeVisible(viewer, "event:1", { visibility_scope: "area_visible", location_entity_id: 50 })).toBe(true);
      expect(policy.isNodeVisible(viewer, "event:2", { visibility_scope: "area_visible", location_entity_id: 99 })).toBe(false);
    });

    it("dispatches entity: refs to isEntityVisible", () => {
      const viewer = makeViewer({ viewer_agent_id: "a1" });
      expect(policy.isNodeVisible(viewer, "entity:1", { memory_scope: "shared_public", owner_agent_id: null })).toBe(true);
      expect(policy.isNodeVisible(viewer, "entity:2", { memory_scope: "private_overlay", owner_agent_id: "a2" })).toBe(false);
    });

    it("dispatches fact: refs to isFactVisible", () => {
      const viewer = makeViewer();
      expect(policy.isNodeVisible(viewer, "fact:1", {})).toBe(true);
    });

    it("returns false for unknown node kind", () => {
      const viewer = makeViewer();
      expect(policy.isNodeVisible(viewer, "unknown:1", {})).toBe(false);
    });
  });

  // ── SQL predicate builders ───────────────────────────────────────

  describe("eventVisibilityPredicate", () => {
    it("returns correct SQL without table alias", () => {
      const viewer = makeViewer({ current_area_id: 42 });
      const sql = policy.eventVisibilityPredicate(viewer);
      expect(sql).toBe("(visibility_scope = 'world_public' OR (visibility_scope = 'area_visible' AND location_entity_id = 42))");
    });

    it("returns correct SQL with table alias", () => {
      const viewer = makeViewer({ current_area_id: 7 });
      const sql = policy.eventVisibilityPredicate(viewer, "e");
      expect(sql).toBe("(e.visibility_scope = 'world_public' OR (e.visibility_scope = 'area_visible' AND e.location_entity_id = 7))");
    });
  });

  describe("entityVisibilityPredicate", () => {
    it("returns correct SQL without table alias", () => {
      const viewer = makeViewer({ viewer_agent_id: "agent-x" });
      const sql = policy.entityVisibilityPredicate(viewer);
      expect(sql).toBe("(memory_scope = 'shared_public' OR (memory_scope = 'private_overlay' AND owner_agent_id = 'agent-x'))");
    });

    it("returns correct SQL with table alias", () => {
      const viewer = makeViewer({ viewer_agent_id: "agent-y" });
      const sql = policy.entityVisibilityPredicate(viewer, "n");
      expect(sql).toBe("(n.memory_scope = 'shared_public' OR (n.memory_scope = 'private_overlay' AND n.owner_agent_id = 'agent-y'))");
    });
  });

  describe("privateNodePredicate", () => {
    it("returns correct SQL without table alias", () => {
      const viewer = makeViewer({ viewer_agent_id: "agent-z" });
      const sql = policy.privateNodePredicate(viewer);
      expect(sql).toBe("agent_id = 'agent-z'");
    });

    it("returns correct SQL with table alias", () => {
      const viewer = makeViewer({ viewer_agent_id: "agent-z" });
      const sql = policy.privateNodePredicate(viewer, "o");
      expect(sql).toBe("o.agent_id = 'agent-z'");
    });
  });

  describe("viewer_role irrelevance", () => {
    it("viewer_role does not affect event visibility", () => {
      const event = { visibility_scope: "area_visible" as const, location_entity_id: 100 };
      const rpViewer = makeViewer({ viewer_role: "rp_agent" });
      const taskViewer = makeViewer({ viewer_role: "task_agent" });
      const maidenViewer = makeViewer({ viewer_role: "maiden" });

      expect(policy.isEventVisible(rpViewer, event)).toBe(true);
      expect(policy.isEventVisible(taskViewer, event)).toBe(true);
      expect(policy.isEventVisible(maidenViewer, event)).toBe(true);
    });

    it("viewer_role does not affect SQL predicate output", () => {
      const rpSql = policy.eventVisibilityPredicate(makeViewer({ viewer_role: "rp_agent" }));
      const taskSql = policy.eventVisibilityPredicate(makeViewer({ viewer_role: "task_agent" }));
      const maidenSql = policy.eventVisibilityPredicate(makeViewer({ viewer_role: "maiden" }));

      expect(rpSql).toBe(taskSql);
      expect(rpSql).toBe(maidenSql);
    });
  });
});
