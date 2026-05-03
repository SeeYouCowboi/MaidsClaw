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

  describe("fact visibility owner scope", () => {
    it("keeps legacy behavior when fact metadata is omitted", () => {
      const viewer = makeViewer("agent-owner");
      expect(policy.isFactVisible(viewer)).toBe(true);
    });

    it("shows shared fact rows to all viewers", () => {
      const viewer = makeViewer("agent-other");
      expect(policy.isFactVisible(viewer, { owner_agent_id: null, predicate: "knows" })).toBe(true);
    });

    it("shows owner-private fact rows only to owner", () => {
      const ownerViewer = makeViewer("agent-owner");
      const otherViewer = makeViewer("agent-other");

      expect(policy.isFactVisible(ownerViewer, { owner_agent_id: "agent-owner", predicate: "likes" })).toBe(true);
      expect(policy.isFactVisible(otherViewer, { owner_agent_id: "agent-owner", predicate: "likes" })).toBe(false);
    });

    it("marks owner-private fact disposition as private for non-owner", () => {
      const viewer = makeViewer("agent-other");
      expect(policy.getNodeDisposition(viewer, "fact:10", {
        owner_agent_id: "agent-owner",
        predicate: "explicit_assertion",
      })).toBe("private");
    });
  });
});
