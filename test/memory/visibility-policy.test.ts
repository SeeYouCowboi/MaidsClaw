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

    it("shows owner-private internal cognition fact (explicit_assertion) to owner", () => {
      const viewer = makeViewer("agent-owner");
      for (const predicate of [
        "explicit_assertion",
        "explicit_evaluation",
        "explicit_commitment",
      ]) {
        expect(policy.isFactVisible(viewer, { owner_agent_id: "agent-owner", predicate })).toBe(true);
        expect(policy.getNodeDisposition(viewer, "fact:7", {
          owner_agent_id: "agent-owner",
          predicate,
        })).toBe("visible");
      }
    });

    it("hides owner-private internal cognition fact from non-owner viewer", () => {
      const otherViewer = makeViewer("agent-other");
      for (const predicate of [
        "explicit_assertion",
        "explicit_evaluation",
        "explicit_commitment",
      ]) {
        expect(policy.isFactVisible(otherViewer, { owner_agent_id: "agent-owner", predicate })).toBe(false);
        expect(policy.getNodeDisposition(otherViewer, "fact:7", {
          owner_agent_id: "agent-owner",
          predicate,
        })).toBe("private");
      }
    });

    it("treats empty-string owner_agent_id as legacy/shared (visible)", () => {
      const viewer = makeViewer("agent-other");
      expect(policy.isFactVisible(viewer, { owner_agent_id: "", predicate: "any" })).toBe(true);
      expect(policy.getNodeDisposition(viewer, "fact:8", {
        owner_agent_id: "",
        predicate: "any",
      })).toBe("visible");
    });

    it("treats undefined owner_agent_id as shared (visible)", () => {
      const viewer = makeViewer("agent-other");
      expect(policy.isFactVisible(viewer, { predicate: "knows" })).toBe(true);
    });

    it("dispatches fact:* nodeRef through isFactVisible via getNodeDisposition", () => {
      const ownerViewer = makeViewer("agent-owner");
      expect(policy.getNodeDisposition(ownerViewer, "fact:99", {
        owner_agent_id: "agent-owner",
        predicate: "knows",
      })).toBe("visible");
      expect(policy.getNodeDisposition(ownerViewer, "fact:99", {
        predicate: "knows",
      })).toBe("visible");
    });
  });

  describe("assertion / evaluation / commitment private node visibility", () => {
    it("is visible only to the owning agent", () => {
      const owner = makeViewer("agent-owner");
      const other = makeViewer("agent-other");
      for (const kind of ["assertion", "evaluation", "commitment"]) {
        expect(policy.isNodeVisible(owner, `${kind}:1`, { agent_id: "agent-owner" })).toBe(true);
        expect(policy.isNodeVisible(other, `${kind}:1`, { agent_id: "agent-owner" })).toBe(false);
        expect(policy.getNodeDisposition(other, `${kind}:1`, { agent_id: "agent-owner" })).toBe("private");
      }
    });
  });

  describe("isEdgeVisible — both endpoints must be visible", () => {
    it("returns true only when both source and target are visible", () => {
      const owner = makeViewer("agent-owner");
      expect(policy.isEdgeVisible(
        owner,
        "assertion:1",
        { agent_id: "agent-owner" },
        "assertion:2",
        { agent_id: "agent-owner" },
      )).toBe(true);
      expect(policy.isEdgeVisible(
        owner,
        "assertion:1",
        { agent_id: "agent-owner" },
        "assertion:2",
        { agent_id: "agent-other" },
      )).toBe(false);
    });
  });
});
