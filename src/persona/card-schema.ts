export type CharacterCardMessage = {
  role: string;
  content: string;
};

export type CharacterCard = {
  id: string;
  name: string;
  description: string;
  persona: string;
  world?: string;
  messageExamples?: CharacterCardMessage[];
  systemPrompt?: string;
  tags?: string[];
  createdAt?: number;
  /** Hidden internal objectives not revealed to the user but available to the agent. */
  hiddenTasks?: string[];
  /** Internal persona description — motivations and constraints the character conceals. */
  privatePersona?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessageExampleArray(value: unknown): value is CharacterCardMessage[] {
  if (!Array.isArray(value)) {
    return false;
  }

  for (const item of value) {
    if (!isRecord(item) || typeof item.role !== "string" || typeof item.content !== "string") {
      return false;
    }
  }

  return true;
}

export function isCharacterCard(value: unknown): value is CharacterCard {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.description !== "string"
    || typeof value.persona !== "string"
  ) {
    return false;
  }

  if (value.world !== undefined && typeof value.world !== "string") {
    return false;
  }

  if (value.messageExamples !== undefined && !isMessageExampleArray(value.messageExamples)) {
    return false;
  }

  if (value.systemPrompt !== undefined && typeof value.systemPrompt !== "string") {
    return false;
  }

  if (
    value.tags !== undefined
    && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))
  ) {
    return false;
  }

  if (value.createdAt !== undefined && typeof value.createdAt !== "number") {
    return false;
  }

  if (
    value.hiddenTasks !== undefined
    && (!Array.isArray(value.hiddenTasks) || value.hiddenTasks.some((t) => typeof t !== "string"))
  ) {
    return false;
  }

  if (value.privatePersona !== undefined && typeof value.privatePersona !== "string") {
    return false;
  }

  return true;
}
