import type { Story, StoryBeat, StoryCharacter } from "../dsl/story-types.js";

export type DialogueTurn = {
  role: "user" | "assistant";
  content: string;
  timestamp: number; // game-world time (ms)
};

export type GeneratedDialogue = {
  beatId: string;
  turns: DialogueTurn[];
};

export type DialogueGenOptions = {
  turnsPerBeat?: number; // default: 6 (range 4-8)
  modelId?: string; // which LLM model to use for generation
};

type LlmBackend = "anthropic" | "openai";

type RawTurn = { role: "user" | "assistant"; content: string };

type DetectedBackend = {
  backend: LlmBackend;
  apiKey: string;
  baseUrl?: string;
  modelOverride?: string;
  extraHeaders?: Record<string, string>;
};

function detectBackend(): DetectedBackend {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) return { backend: "anthropic", apiKey: anthropicKey };

  // MiniMax uses Anthropic-compatible protocol
  const minimaxKey = process.env.MINIMAX_API_KEY;
  if (minimaxKey) {
    return {
      backend: "anthropic",
      apiKey: minimaxKey,
      baseUrl: "https://api.minimaxi.com/anthropic",
      modelOverride: "MiniMax-M2.7-highspeed",
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) return { backend: "openai", apiKey: openaiKey };

  // Moonshot uses OpenAI-compatible protocol
  const moonshotKey = process.env.MOONSHOT_API_KEY;
  if (moonshotKey) {
    return {
      backend: "openai",
      apiKey: moonshotKey,
      baseUrl: "https://api.moonshot.cn",
      modelOverride: "kimi-k2.5",
    };
  }

  // Kimi Coding uses OpenAI-compatible protocol
  const kimiKey = process.env.KIMI_CODING_API_KEY;
  if (kimiKey) {
    return {
      backend: "openai",
      apiKey: kimiKey,
      baseUrl: "https://api.kimi.com/coding",
      modelOverride: "kimi-for-coding",
      extraHeaders: { "user-agent": "claude-code/1.0" },
    };
  }

  throw new Error(
    "dialogue-generator: no supported LLM API key found in environment",
  );
}

function clampTurns(n: number | undefined): number {
  if (n === undefined) return 6;
  return Math.max(4, Math.min(8, n));
}

function buildCharacterBlock(characters: StoryCharacter[]): string {
  return characters
    .map((c) => {
      const aliases = c.aliases.length > 0 ? ` (aliases: ${c.aliases.join(", ")})` : "";
      return `- ${c.displayName}${aliases}: ${c.surfaceMotives}`;
    })
    .join("\n");
}

function buildSystemPrompt(
  story: Story,
  beat: StoryBeat,
  turnsPerBeat: number,
): string {
  const characterBlock = buildCharacterBlock(story.characters);

  const participantNames = beat.participantIds
    .map((pid) => {
      const ch = story.characters.find((c) => c.id === pid);
      return ch ? ch.displayName : pid;
    })
    .join(", ");

  const location = story.locations.find((l) => l.id === beat.locationId);
  const locationName = location ? location.displayName : beat.locationId;

  const lyingNote = beat.whoIsLying
    ? `\nNote: ${beat.whoIsLying.characterId} is being deceptive about: ${beat.whoIsLying.about}`
    : "";

  return `You are a screenwriter generating dialogue for a mystery story set in a Victorian manor.

STORY CONTEXT:
Title: ${story.title}
Description: ${story.description}
Characters:
${characterBlock}

Current scene: ${locationName} with ${participantNames}
What happens: ${beat.dialogueGuidance}${lyingNote}

INSTRUCTIONS:
Generate exactly ${turnsPerBeat} dialogue turns. Output ONLY a JSON array:
[{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}, ...]
- "user" = the questioner/investigator
- "assistant" = the maid protagonist
- Make dialogue feel natural and reveal the beat's key information through conversation
- Use formal Victorian manor language ("I beg your pardon", "Indeed", "Your Lordship", etc.)
- DO NOT include any text outside the JSON array`;
}

async function callAnthropicRaw(
  apiKey: string,
  systemPrompt: string,
  modelId: string,
  baseUrl?: string,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const response = await fetch(`${baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 2048,
      temperature: 0.7,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: "Generate the dialogue now.",
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body}`);
  }

  const json = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const textBlock = json.content.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error("Anthropic response contained no text block");
  }
  return textBlock.text;
}

async function callOpenAIRaw(
  apiKey: string,
  systemPrompt: string,
  modelId: string,
  baseUrl?: string,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const response = await fetch(`${baseUrl ?? "https://api.openai.com"}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 2048,
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Generate the dialogue now." },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${body}`);
  }

  const json = (await response.json()) as {
    choices: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response contained no message content");
  }
  return content;
}

function defaultModelId(backend: LlmBackend): string {
  return backend === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini";
}

async function callLlm(
  detected: DetectedBackend,
  systemPrompt: string,
  modelId: string,
): Promise<string> {
  return detected.backend === "anthropic"
    ? callAnthropicRaw(detected.apiKey, systemPrompt, modelId, detected.baseUrl, detected.extraHeaders)
    : callOpenAIRaw(detected.apiKey, systemPrompt, modelId, detected.baseUrl, detected.extraHeaders);
}

function parseDialogueTurns(raw: string): RawTurn[] {
  // Strip markdown code fences if the LLM wraps its output
  const stripped = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  const parsed: unknown = JSON.parse(stripped);

  if (!Array.isArray(parsed)) {
    throw new Error("LLM response is not a JSON array");
  }

  for (const item of parsed) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("role" in item) ||
      !("content" in item)
    ) {
      throw new Error("Dialogue turn missing role or content");
    }
    const turn = item as { role: unknown; content: unknown };
    if (turn.role !== "user" && turn.role !== "assistant") {
      throw new Error(`Invalid role: ${String(turn.role)}`);
    }
    if (typeof turn.content !== "string") {
      throw new Error("Turn content must be a string");
    }
  }

  return parsed as RawTurn[];
}

function assignTimestamps(
  rawTurns: RawTurn[],
  beatTimestamp: number,
): DialogueTurn[] {
  const beatDuration = 60_000; // 1 minute per beat
  const count = rawTurns.length;
  const interval = count > 1 ? beatDuration / (count - 1) : 0;

  return rawTurns.map((turn, idx) => ({
    role: turn.role,
    content: turn.content,
    timestamp: beatTimestamp + Math.round(idx * interval),
  }));
}

export async function generateDialogue(
  story: Story,
  options?: DialogueGenOptions,
): Promise<GeneratedDialogue[]> {
  const detected = detectBackend();
  const turnsPerBeat = clampTurns(options?.turnsPerBeat);
  const modelId = options?.modelId ?? detected.modelOverride ?? defaultModelId(detected.backend);

  const results: GeneratedDialogue[] = [];

  for (const beat of story.beats) {
    const systemPrompt = buildSystemPrompt(story, beat, turnsPerBeat);
    let rawText: string;
    let rawTurns: RawTurn[];

    try {
      rawText = await callLlm(detected, systemPrompt, modelId);
      rawTurns = parseDialogueTurns(rawText);
    } catch {
      try {
        rawText = await callLlm(detected, systemPrompt, modelId);
        rawTurns = parseDialogueTurns(rawText);
      } catch (retryError) {
        throw new Error(
          `Failed to generate dialogue for beat "${beat.id}" after retry: ${
            retryError instanceof Error ? retryError.message : String(retryError)
          }`,
        );
      }
    }

    results.push({
      beatId: beat.id,
      turns: assignTimestamps(rawTurns, beat.timestamp),
    });
  }

  return results;
}
