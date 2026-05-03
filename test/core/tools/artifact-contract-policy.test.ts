import { describe, expect, it } from "bun:test";

import { MaidsClawError } from "../../../src/core/errors.js";
import {
  enforceArtifactContracts,
  filterArtifactsByScope,
} from "../../../src/core/tools/artifact-contract-policy.js";
import { makeSubmitRpTurnTool } from "../../../src/runtime/submit-rp-turn-tool.js";

function getContracts() {
  const contracts = makeSubmitRpTurnTool().artifactContracts;
  if (!contracts) {
    throw new Error("submit_rp_turn artifactContracts must be defined");
  }
  return contracts;
}

describe("artifact-contract-policy", () => {
  it("enforceArtifactContracts throws ARTIFACT_CONTRACT_DENIED on authority mismatch", () => {
    const contracts = getContracts();

    let caught: unknown;
    try {
      enforceArtifactContracts(contracts, {
        writingAgentId: "rp:bob",
        ownerAgentId: "rp:alice",
        writeOperation: "append",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(caught instanceof MaidsClawError).toBe(true);
    expect((caught as MaidsClawError).code).toBe("ARTIFACT_CONTRACT_DENIED");
  });

  it("enforceArtifactContracts passes when authority matches", () => {
    const contracts = getContracts();

    expect(() =>
      enforceArtifactContracts(contracts, {
        writingAgentId: "rp:alice",
        ownerAgentId: "rp:alice",
        writeOperation: "append",
      }),
    ).not.toThrow();
  });

  it("enforceArtifactContracts throws when append_only contract receives overwrite", () => {
    const contracts = getContracts();

    let caught: unknown;
    try {
      enforceArtifactContracts(contracts, {
        writingAgentId: "rp:alice",
        ownerAgentId: "rp:alice",
        writeOperation: "overwrite",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(caught instanceof MaidsClawError).toBe(true);
    expect((caught as MaidsClawError).code).toBe("ARTIFACT_CONTRACT_DENIED");
  });

  it("enforceArtifactContracts allows append_only contracts with append operation", () => {
    const contracts = getContracts();

    expect(() =>
      enforceArtifactContracts(contracts, {
        writingAgentId: "rp:alice",
        ownerAgentId: "rp:alice",
        writeOperation: "append",
      }),
    ).not.toThrow();
  });

  it("filterArtifactsByScope excludes private artifacts from world/area/session", () => {
    const contracts = getContracts();

    const filtered = filterArtifactsByScope(contracts, ["world", "area", "session"]);

    expect(filtered).toContain("publicReply");
    expect(filtered).toContain("publications");
    expect(filtered).toContain("pinnedSummaryProposal");
    expect(filtered).toContain("actionCommitments");
    expect(filtered).not.toContain("privateCognition");
    expect(filtered).not.toContain("privateEpisodes");
    expect(filtered).not.toContain("relationIntents");
    expect(filtered).not.toContain("conflictFactors");
  });

  it("filterArtifactsByScope includes world artifacts", () => {
    const contracts = getContracts();

    const worldArtifacts = filterArtifactsByScope(contracts, ["world"]);

    expect(worldArtifacts).toEqual(["publicReply"]);
    expect(worldArtifacts).not.toContain("actionCommitments");
  });

  it("filterArtifactsByScope includes actionCommitments for session scope", () => {
    const contracts = getContracts();

    const sessionArtifacts = filterArtifactsByScope(contracts, ["session"]);

    expect(sessionArtifacts).toContain("pinnedSummaryProposal");
    expect(sessionArtifacts).toContain("actionCommitments");
  });

  it("all submit_rp_turn contracts pass enforcement for append writes", () => {
    const contracts = getContracts();

    expect(Object.keys(contracts)).toHaveLength(9);
    expect(() =>
      enforceArtifactContracts(contracts, {
        writingAgentId: "rp:alice",
        ownerAgentId: "rp:alice",
        writeOperation: "append",
      }),
    ).not.toThrow();
  });
});
