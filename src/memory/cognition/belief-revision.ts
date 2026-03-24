import { MaidsClawError } from "../../core/errors.js";
import type { AssertionBasis, AssertionStance } from "../../runtime/rp-turn-contract.js";

/**
 * Stances that cannot be transitioned out of.
 * Once an assertion reaches these states, it is terminal.
 */
const TERMINAL_STANCES: ReadonlySet<AssertionStance> = new Set(["rejected", "abandoned"]);

/**
 * Allowed stance transitions map.
 * Each entry defines which stances can be transitioned TO from a given current stance.
 */
const ALLOWED_STANCE_TRANSITIONS: ReadonlyMap<AssertionStance, ReadonlySet<AssertionStance>> = new Map([
  ["hypothetical", new Set(["tentative", "accepted", "contested", "rejected", "abandoned"])],
  ["tentative", new Set(["accepted", "contested", "rejected", "abandoned"])],
  ["accepted", new Set(["confirmed", "contested", "rejected", "abandoned", "tentative"])],
  ["confirmed", new Set(["accepted", "contested"])],
  ["contested", new Set(["rejected"])],
  ["rejected", new Set()],
  ["abandoned", new Set()],
]);

/**
 * Allowed basis upgrades.
 * These represent valid transitions from weaker to stronger evidentiary bases.
 * Format: "currentBasis->nextBasis"
 */
const ALLOWED_BASIS_UPGRADES = new Set<string>([
  "belief->inference",
  "belief->first_hand",
  "inference->first_hand",
  "hearsay->first_hand",
]);

/**
 * State of an existing assertion as read from the database.
 */
type ExistingAssertionState = {
  id: number;
  stance: AssertionStance | null;
  basis: AssertionBasis | null;
  preContestedStance: AssertionStance | null;
};

/**
 * Asserts that a stance transition is legal according to the state machine rules.
 *
 * Special handling for contested stances:
 * - contested → rejected is always allowed
 * - contested → X requires preContestedStance to exist and match X
 *
 * @param existing - The current state of the assertion
 * @param nextStance - The desired next stance
 * @param cognitionKey - The cognition key for error reporting
 * @throws MaidsClawError if the transition is illegal
 */
function assertLegalStanceTransition(
  existing: ExistingAssertionState,
  nextStance: AssertionStance,
  cognitionKey: string,
): void {
  const currentStance = existing.stance;
  if (!currentStance) {
    return;
  }

  if (currentStance === "contested" && nextStance !== "rejected") {
    if (!existing.preContestedStance) {
      throw new MaidsClawError({
        code: "COGNITION_MISSING_PRE_CONTESTED_STANCE",
        message: "contested rollback requires pre_contested_stance on existing assertion",
        retriable: false,
        details: { cognitionKey, currentStance, targetStance: nextStance },
      });
    }
    if (nextStance === existing.preContestedStance) {
      return;
    }
    throw new MaidsClawError({
      code: "COGNITION_ILLEGAL_STANCE_TRANSITION",
      message: "illegal stance transition",
      retriable: false,
      details: {
        cognitionKey,
        currentStance,
        targetStance: nextStance,
        preContestedStance: existing.preContestedStance,
      },
    });
  }

  const legalTargets = ALLOWED_STANCE_TRANSITIONS.get(currentStance);
  if (legalTargets?.has(nextStance)) {
    return;
  }

  throw new MaidsClawError({
    code: "COGNITION_ILLEGAL_STANCE_TRANSITION",
    message: "illegal stance transition",
    retriable: false,
    details: { cognitionKey, currentStance, targetStance: nextStance },
  });
}

/**
 * Asserts that a basis change is an allowed upgrade (not a downgrade or lateral move).
 *
 * Allowed upgrades are defined in ALLOWED_BASIS_UPGRADES.
 *
 * @param currentBasis - The current basis of the assertion
 * @param nextBasis - The desired next basis
 * @param cognitionKey - The cognition key for error reporting
 * @throws MaidsClawError if the change is not an allowed upgrade
 */
function assertBasisUpgradeOnly(
  currentBasis: AssertionBasis | null,
  nextBasis: AssertionBasis | undefined,
  cognitionKey: string,
): void {
  if (!currentBasis || !nextBasis || currentBasis === nextBasis) {
    return;
  }

  if (ALLOWED_BASIS_UPGRADES.has(`${currentBasis}->${nextBasis}`)) {
    return;
  }

  throw new MaidsClawError({
    code: "COGNITION_ILLEGAL_BASIS_DOWNGRADE",
    message: "assertion basis change is not an allowed upgrade",
    retriable: false,
    details: { cognitionKey, currentBasis, targetBasis: nextBasis },
  });
}

export {
  TERMINAL_STANCES,
  ALLOWED_STANCE_TRANSITIONS,
  ALLOWED_BASIS_UPGRADES,
  assertLegalStanceTransition,
  assertBasisUpgradeOnly,
};

export type { ExistingAssertionState };
