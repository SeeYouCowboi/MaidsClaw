import { describe, expect, it } from "bun:test";
import { VisibilityPolicy } from "../../src/memory/visibility-policy.js";
import type { ViewerContext } from "../../src/memory/types.js";

describe("VisibilityPolicy", () => {
  const policy = new VisibilityPolicy();

  function makeViewer(agentId: string, areaId?: number): ViewerContext {
    return {
      viewer_agent_id: agentId,
      current_area_id: areaId ?? null,
      session_id: "test-session",
    };
  }

  describe("owner_private event visibility", () => {
    it("is visible to the owner agent", () => {
      const viewer = makeViewer("agent-owner");
      const nodeData = {
        visibility_scope: "owner_private",
        owner_agent_id: "agent-owner",
        location_entity_id: 1,
      };
      expect(policy.isNodeVisible(viewer, "event:42", nodeData)).toBe(true);
      expect(policy.getNodeDisposition(viewer, "event:42", nodeData)).toBe("visible");
    });

    it("is hidden from a non-owner agent", () => {
      const viewer = makeViewer("agent-other");
      const nodeData = {
        visibility_scope: "owner_private",
        owner_agent_id: "agent-owner",
        location_entity_id: 1,
      };
      expect(policy.isNodeVisible(viewer, "event:42", nodeData)).toBe(false);
      expect(policy.getNodeDisposition(viewer, "event:42", nodeData)).toBe("private");
    });

    it("is hidden when ownerAgentId is null", () => {
      const viewer = makeViewer("agent-owner");
      const nodeData = {
        visibility_scope: "owner_private",
        owner_agent_id: null,
        location_entity_id: 1,
      };
      expect(policy.isNodeVisible(viewer, "event:42", nodeData)).toBe(false);
      expect(policy.getNodeDisposition(viewer, "event:42", nodeData)).toBe("private");
    });
  });

  describe("episode: kind visibility", () => {
    it("is visible to the owner agent", () => {
      const viewer = makeViewer("agent-owner");
      const nodeData = { agent_id: "agent-owner" };
      expect(policy.isNodeVisible(viewer, "episode:42", nodeData)).toBe(true);
      expect(policy.getNodeDisposition(viewer, "episode:42", nodeData)).toBe("visible");
    });

    it("is hidden from a non-owner agent", () => {
      const viewer = makeViewer("agent-other");
      const nodeData = { agent_id: "agent-owner" };
      expect(policy.isNodeVisible(viewer, "episode:42", nodeData)).toBe(false);
      expect(policy.getNodeDisposition(viewer, "episode:42", nodeData)).toBe("private");
    });
  });
});
