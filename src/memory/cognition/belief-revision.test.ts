import { describe, it, expect } from "bun:test";
import {
  TERMINAL_STANCES,
  ALLOWED_STANCE_TRANSITIONS,
  ALLOWED_BASIS_UPGRADES,
  assertLegalStanceTransition,
  assertBasisUpgradeOnly,
} from "./belief-revision.js";
import type { AssertionStance, AssertionBasis } from "../../runtime/rp-turn-contract.js";
import { MaidsClawError } from "../../core/errors.js";

describe("belief-revision / TERMINAL_STANCES", () => {
  it("should contain rejected and abandoned as terminal stances", () => {
    expect(TERMINAL_STANCES.has("rejected")).toBe(true);
    expect(TERMINAL_STANCES.has("abandoned")).toBe(true);
  });

  it("should NOT contain non-terminal stances", () => {
    expect(TERMINAL_STANCES.has("hypothetical")).toBe(false);
    expect(TERMINAL_STANCES.has("tentative")).toBe(false);
    expect(TERMINAL_STANCES.has("accepted")).toBe(false);
    expect(TERMINAL_STANCES.has("confirmed")).toBe(false);
    expect(TERMINAL_STANCES.has("contested")).toBe(false);
  });
});

describe("belief-revision / ALLOWED_STANCE_TRANSITIONS", () => {
  it("should allow hypothetical → tentative", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("hypothetical")?.has("tentative")).toBe(true);
  });

  it("should allow hypothetical → accepted", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("hypothetical")?.has("accepted")).toBe(true);
  });

  it("should allow hypothetical → contested", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("hypothetical")?.has("contested")).toBe(true);
  });

  it("should allow hypothetical → rejected", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("hypothetical")?.has("rejected")).toBe(true);
  });

  it("should allow hypothetical → abandoned", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("hypothetical")?.has("abandoned")).toBe(true);
  });

  it("should allow tentative → accepted", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("tentative")?.has("accepted")).toBe(true);
  });

  it("should allow tentative → contested", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("tentative")?.has("contested")).toBe(true);
  });

  it("should allow tentative → rejected", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("tentative")?.has("rejected")).toBe(true);
  });

  it("should allow tentative → abandoned", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("tentative")?.has("abandoned")).toBe(true);
  });

  it("should allow accepted → confirmed", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("accepted")?.has("confirmed")).toBe(true);
  });

  it("should allow accepted → contested", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("accepted")?.has("contested")).toBe(true);
  });

  it("should allow accepted → rejected", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("accepted")?.has("rejected")).toBe(true);
  });

  it("should allow accepted → abandoned", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("accepted")?.has("abandoned")).toBe(true);
  });

  it("should allow accepted → tentative (rollback)", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("accepted")?.has("tentative")).toBe(true);
  });

  it("should allow confirmed → accepted (rollback)", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("confirmed")?.has("accepted")).toBe(true);
  });

  it("should allow confirmed → contested", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("confirmed")?.has("contested")).toBe(true);
  });

  it("should NOT allow confirmed → rejected directly", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("confirmed")?.has("rejected")).toBe(false);
  });

  it("should NOT allow confirmed → abandoned", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("confirmed")?.has("abandoned")).toBe(false);
  });

  it("should allow contested → rejected", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("contested")?.has("rejected")).toBe(true);
  });

  it("should NOT allow contested → accepted directly", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("contested")?.has("accepted")).toBe(false);
  });

  it("should NOT allow contested → tentative directly", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("contested")?.has("tentative")).toBe(false);
  });

  it("should have empty transitions for rejected (terminal)", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("rejected")?.size).toBe(0);
  });

  it("should have empty transitions for abandoned (terminal)", () => {
    expect(ALLOWED_STANCE_TRANSITIONS.get("abandoned")?.size).toBe(0);
  });
});

describe("belief-revision / ALLOWED_BASIS_UPGRADES", () => {
  it("should allow belief -> inference", () => {
    expect(ALLOWED_BASIS_UPGRADES.has("belief->inference")).toBe(true);
  });

  it("should allow belief -> first_hand", () => {
    expect(ALLOWED_BASIS_UPGRADES.has("belief->first_hand")).toBe(true);
  });

  it("should allow inference -> first_hand", () => {
    expect(ALLOWED_BASIS_UPGRADES.has("inference->first_hand")).toBe(true);
  });

  it("should allow hearsay -> first_hand", () => {
    expect(ALLOWED_BASIS_UPGRADES.has("hearsay->first_hand")).toBe(true);
  });

  it("should NOT allow first_hand -> belief (downgrade)", () => {
    expect(ALLOWED_BASIS_UPGRADES.has("first_hand->belief")).toBe(false);
  });

  it("should NOT allow inference -> hearsay (lateral)", () => {
    expect(ALLOWED_BASIS_UPGRADES.has("inference->hearsay")).toBe(false);
  });
});

describe("belief-revision / assertLegalStanceTransition", () => {
  const createExisting = (stance: AssertionStance | null, preContestedStance: AssertionStance | null = null) => ({
    id: 1,
    stance,
    basis: null as AssertionBasis | null,
    preContestedStance,
  });

  it("should not throw when current stance is null", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting(null), "accepted", "test-key")
    ).not.toThrow();
  });

  it("should not throw for legal transition: hypothetical → tentative", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("hypothetical"), "tentative", "test-key")
    ).not.toThrow();
  });

  it("should not throw for legal transition: hypothetical → accepted", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("hypothetical"), "accepted", "test-key")
    ).not.toThrow();
  });

  it("should not throw for legal transition: tentative → accepted", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("tentative"), "accepted", "test-key")
    ).not.toThrow();
  });

  it("should not throw for legal transition: accepted → confirmed", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("accepted"), "confirmed", "test-key")
    ).not.toThrow();
  });

  it("should not throw for legal rollback: confirmed → accepted", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("confirmed"), "accepted", "test-key")
    ).not.toThrow();
  });

  it("should not throw for legal rollback: accepted → tentative", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("accepted"), "tentative", "test-key")
    ).not.toThrow();
  });

  it("should throw for illegal transition: confirmed → rejected", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("confirmed"), "rejected", "test-key")
    ).toThrow(MaidsClawError);
  });

  it("should throw for illegal transition: confirmed → abandoned", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("confirmed"), "abandoned", "test-key")
    ).toThrow(MaidsClawError);
  });

  it("should throw for illegal transition: tentative → hypothetical", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("tentative"), "hypothetical", "test-key")
    ).toThrow(MaidsClawError);
  });

  it("should throw for illegal transition: rejected → accepted", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("rejected"), "accepted", "test-key")
    ).toThrow(MaidsClawError);
  });

  it("should throw for illegal transition: abandoned → tentative", () => {
    expect(() =>
      assertLegalStanceTransition(createExisting("abandoned"), "tentative", "test-key")
    ).toThrow(MaidsClawError);
  });

  describe("contested stance transitions", () => {
    it("should throw for contested → accepted (no preContestedStance)", () => {
      expect(() =>
        assertLegalStanceTransition(createExisting("contested", null), "accepted", "test-key")
      ).toThrow(MaidsClawError);
    });

    it("should throw for contested → tentative (no preContestedStance)", () => {
      expect(() =>
        assertLegalStanceTransition(createExisting("contested", null), "tentative", "test-key")
      ).toThrow(MaidsClawError);
    });

    it("should allow contested → rejected (regardless of preContestedStance)", () => {
      expect(() =>
        assertLegalStanceTransition(createExisting("contested", "accepted"), "rejected", "test-key")
      ).not.toThrow();
    });

    it("should allow contested → preContestedStance when preContestedStance exists", () => {
      expect(() =>
        assertLegalStanceTransition(createExisting("contested", "accepted"), "accepted", "test-key")
      ).not.toThrow();
    });

    it("should allow contested → preContestedStance (tentative)", () => {
      expect(() =>
        assertLegalStanceTransition(createExisting("contested", "tentative"), "tentative", "test-key")
      ).not.toThrow();
    });

    describe("one-step-below preContestedStance transitions", () => {
      it("should allow contested → accepted when preContestedStance=confirmed (one step down)", () => {
        expect(() =>
          assertLegalStanceTransition(createExisting("contested", "confirmed"), "accepted", "test-key")
        ).not.toThrow();
      });

      it("should allow contested → tentative when preContestedStance=accepted (one step down)", () => {
        expect(() =>
          assertLegalStanceTransition(createExisting("contested", "accepted"), "tentative", "test-key")
        ).not.toThrow();
      });

      it("should throw for contested → tentative when preContestedStance=confirmed (two steps down)", () => {
        expect(() =>
          assertLegalStanceTransition(createExisting("contested", "confirmed"), "tentative", "test-key")
        ).toThrow(MaidsClawError);
      });

      it("should throw for contested → hypothetical when preContestedStance=accepted (two steps down)", () => {
        expect(() =>
          assertLegalStanceTransition(createExisting("contested", "accepted"), "hypothetical", "test-key")
        ).toThrow(MaidsClawError);
      });

      it("should still require preContestedStance for one-step-below logic", () => {
        expect(() =>
          assertLegalStanceTransition(createExisting("contested", null), "accepted", "test-key")
        ).toThrow(MaidsClawError);
      });
    });
  });

  describe("error details", () => {
    it("should include COGNITION_ILLEGAL_STANCE_TRANSITION code", () => {
      try {
        assertLegalStanceTransition(createExisting("confirmed"), "rejected", "my-key");
      } catch (e) {
        expect(e).toBeInstanceOf(MaidsClawError);
        const error = e as MaidsClawError;
        expect(error.code).toBe("COGNITION_ILLEGAL_STANCE_TRANSITION");
        const details = error.details as Record<string, unknown>;
        expect(details.cognitionKey).toBe("my-key");
        expect(details.currentStance).toBe("confirmed");
        expect(details.targetStance).toBe("rejected");
      }
    });

    it("should include preContestedStance in details for contested errors", () => {
      try {
        assertLegalStanceTransition(createExisting("contested", "accepted"), "tentative", "my-key");
      } catch (e) {
        expect(e).toBeInstanceOf(MaidsClawError);
        const error = e as MaidsClawError;
        expect(error.code).toBe("COGNITION_ILLEGAL_STANCE_TRANSITION");
        expect((error.details as Record<string, unknown>).preContestedStance).toBe("accepted");
      }
    });

    it("should include COGNITION_MISSING_PRE_CONTESTED_STANCE code when missing", () => {
      try {
        assertLegalStanceTransition(createExisting("contested", null), "accepted", "my-key");
      } catch (e) {
        expect(e).toBeInstanceOf(MaidsClawError);
        const error = e as MaidsClawError;
        expect(error.code).toBe("COGNITION_MISSING_PRE_CONTESTED_STANCE");
      }
    });
  });
});

describe("belief-revision / assertBasisUpgradeOnly", () => {
  it("should not throw when current basis is null", () => {
    expect(() =>
      assertBasisUpgradeOnly(null, "first_hand", "test-key")
    ).not.toThrow();
  });

  it("should not throw when next basis is undefined", () => {
    expect(() =>
      assertBasisUpgradeOnly("belief", undefined, "test-key")
    ).not.toThrow();
  });

  it("should not throw when bases are the same", () => {
    expect(() =>
      assertBasisUpgradeOnly("belief", "belief", "test-key")
    ).not.toThrow();
  });

  it("should allow belief -> inference", () => {
    expect(() =>
      assertBasisUpgradeOnly("belief", "inference", "test-key")
    ).not.toThrow();
  });

  it("should allow belief -> first_hand", () => {
    expect(() =>
      assertBasisUpgradeOnly("belief", "first_hand", "test-key")
    ).not.toThrow();
  });

  it("should allow inference -> first_hand", () => {
    expect(() =>
      assertBasisUpgradeOnly("inference", "first_hand", "test-key")
    ).not.toThrow();
  });

  it("should allow hearsay -> first_hand", () => {
    expect(() =>
      assertBasisUpgradeOnly("hearsay", "first_hand", "test-key")
    ).not.toThrow();
  });

  it("should throw for downgrade: first_hand -> belief", () => {
    expect(() =>
      assertBasisUpgradeOnly("first_hand", "belief", "test-key")
    ).toThrow(MaidsClawError);
  });

  it("should throw for downgrade: first_hand -> hearsay", () => {
    expect(() =>
      assertBasisUpgradeOnly("first_hand", "hearsay", "test-key")
    ).toThrow(MaidsClawError);
  });

  it("should throw for lateral change: inference -> hearsay", () => {
    expect(() =>
      assertBasisUpgradeOnly("inference", "hearsay", "test-key")
    ).toThrow(MaidsClawError);
  });

  it("should throw for lateral change: hearsay -> inference", () => {
    expect(() =>
      assertBasisUpgradeOnly("hearsay", "inference", "test-key")
    ).toThrow(MaidsClawError);
  });

  describe("error details", () => {
    it("should include COGNITION_ILLEGAL_BASIS_DOWNGRADE code", () => {
      try {
        assertBasisUpgradeOnly("first_hand", "belief", "my-key");
      } catch (e) {
        expect(e).toBeInstanceOf(MaidsClawError);
        const error = e as MaidsClawError;
        expect(error.code).toBe("COGNITION_ILLEGAL_BASIS_DOWNGRADE");
        const details = error.details as Record<string, unknown>;
        expect(details.cognitionKey).toBe("my-key");
        expect(details.currentBasis).toBe("first_hand");
        expect(details.targetBasis).toBe("belief");
      }
    });
  });
});
