import type { CharacterCard } from "./card-schema.js";
import { tokenizeQuery } from "../memory/query-tokenizer.js";

export type DriftReport = {
  hasDrift: boolean;
  driftScore: number;
  changedSections: string[];
  summary: string;
};

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildCharFrequency(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const char of text) {
    freq.set(char, (freq.get(char) ?? 0) + 1);
  }
  return freq;
}

function characterOverlapRatio(left: string, right: string): number {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);

  if (normalizedLeft.length === 0 && normalizedRight.length === 0) {
    return 1;
  }

  const denominator = Math.max(normalizedLeft.length, normalizedRight.length);
  if (denominator === 0) {
    return 1;
  }

  const leftFrequency = buildCharFrequency(normalizedLeft);
  const rightFrequency = buildCharFrequency(normalizedRight);

  let overlap = 0;
  for (const [char, count] of leftFrequency.entries()) {
    const rightCount = rightFrequency.get(char) ?? 0;
    overlap += Math.min(count, rightCount);
  }

  return overlap / denominator;
}

function isSectionChanged(originalSection: string, currentPersonaText: string): boolean {
  const normalizedOriginal = normalizeText(originalSection);
  const normalizedCurrent = normalizeText(currentPersonaText);

  if (normalizedOriginal.length === 0) {
    return false;
  }

  if (normalizedCurrent.includes(normalizedOriginal)) {
    return false;
  }

  const originalWords = new Set(tokenizeQuery(normalizedOriginal));
  const currentWords = new Set(tokenizeQuery(normalizedCurrent));

  if (originalWords.size === 0) {
    return false;
  }

  let shared = 0;
  for (const word of originalWords) {
    if (currentWords.has(word)) {
      shared += 1;
    }
  }

  const wordOverlapRatio = shared / originalWords.size;
  return wordOverlapRatio < 0.4;
}

export class DriftDetector {
  detectDrift(originalCard: CharacterCard, currentPersonaText: string): DriftReport {
    const baseline = `${originalCard.persona}\n${originalCard.description}`;
    const baselineSimilarity = characterOverlapRatio(baseline, currentPersonaText);
    const driftScore = 1 - baselineSimilarity;

    const changedSections: string[] = [];

    if (isSectionChanged(originalCard.persona, currentPersonaText)) {
      changedSections.push("persona");
    }
    if (isSectionChanged(originalCard.description, currentPersonaText)) {
      changedSections.push("description");
    }
    if (originalCard.privatePersona && isSectionChanged(originalCard.privatePersona, currentPersonaText)) {
      changedSections.push("privatePersona");
    }
    if (originalCard.hiddenTasks) {
      const hiddenTasksText = originalCard.hiddenTasks.join(" ");
      if (hiddenTasksText.length > 0 && isSectionChanged(hiddenTasksText, currentPersonaText)) {
        changedSections.push("hiddenTasks");
      }
    }

    const hasDrift = driftScore > 0.3;
    const summary = hasDrift
      ? `Detected persona drift (${driftScore.toFixed(2)}).`
      : `Persona remains aligned (${driftScore.toFixed(2)}).`;

    return {
      hasDrift,
      driftScore,
      changedSections,
      summary,
    };
  }
}
