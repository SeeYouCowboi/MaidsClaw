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
  onBeatGenerated?: (beat: GeneratedDialogue, allSoFar: GeneratedDialogue[]) => void;
  skipBeatIds?: Set<string>; // beats already cached — skip generation
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
  // Some third-party providers (e.g. MiniMax) reject custom temperature.
  // Only include it for native Anthropic.
  const isNative = !baseUrl || baseUrl.includes("anthropic.com");
  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: "Generate the dialogue now." }],
  };
  if (isNative) body.temperature = 0.7;

  const response = await fetch(`${baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
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
  const isMoonshot = !!baseUrl && baseUrl.includes("moonshot.cn");
  const isThirdParty = !!baseUrl && !baseUrl.includes("openai.com");
  const maxTokens = isThirdParty ? 8192 : 2048;
  const reqBody: Record<string, unknown> = {
    model: modelId,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Generate the dialogue now." },
    ],
  };
  // Kimi K2.5: disable thinking for dialogue generation — structured output
  // doesn't benefit from reasoning and it wastes ~35s per call.
  if (isMoonshot) {
    reqBody.thinking = { type: "disabled" };
    reqBody.temperature = 0.7;
  } else if (!isThirdParty) {
    reqBody.temperature = 0.7;
  }

  const response = await fetch(`${baseUrl ?? "https://api.openai.com"}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(reqBody),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${body}`);
  }

  const json = (await response.json()) as {
    choices: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  const message = json.choices?.[0]?.message;
  // Reasoning models (e.g. Kimi K2.5) may place the actual output in
  // reasoning_content when the content field is empty or when the model's
  // internal reasoning accidentally includes the structured output.
  const content = message?.content || message?.reasoning_content;
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

/**
 * Send the LLM's malformed output back to it with the parse error,
 * asking it to return corrected valid JSON.
 */
async function callLlmWithCorrection(
  detected: DetectedBackend,
  systemPrompt: string,
  modelId: string,
  badOutput: string,
  parseError: string,
): Promise<string> {
  const correctionMsg =
    `Your previous response was invalid JSON. Error: ${parseError}\n` +
    `Here is what you returned:\n\`\`\`\n${badOutput.slice(0, 2000)}\n\`\`\`\n` +
    `Please return ONLY a corrected, valid JSON array with the same dialogue content.`;

  if (detected.backend === "anthropic") {
    const url = `${detected.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
    const isNative = !detected.baseUrl || detected.baseUrl.includes("anthropic.com");
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        { role: "user", content: "Generate the dialogue now." },
        { role: "assistant", content: badOutput.slice(0, 3000) },
        { role: "user", content: correctionMsg },
      ],
    };
    if (isNative) body.temperature = 0.7;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": detected.apiKey,
        "anthropic-version": "2023-06-01",
        ...detected.extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Anthropic correction API ${resp.status}: ${await resp.text()}`);
    const json = (await resp.json()) as { content: Array<{ type: string; text?: string }> };
    return json.content.find((b) => b.type === "text")?.text ?? "";
  } else {
    const url = `${detected.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`;
    const isMoonshot = !!detected.baseUrl && detected.baseUrl.includes("moonshot.cn");
    const isThirdParty = !!detected.baseUrl && !detected.baseUrl.includes("openai.com");
    const reqBody: Record<string, unknown> = {
      model: modelId,
      max_tokens: isThirdParty ? 8192 : 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Generate the dialogue now." },
        { role: "assistant", content: badOutput.slice(0, 3000) },
        { role: "user", content: correctionMsg },
      ],
    };
    if (isMoonshot) {
      reqBody.thinking = { type: "disabled" };
      reqBody.temperature = 0.7;
    } else if (!isThirdParty) {
      reqBody.temperature = 0.7;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${detected.apiKey}`,
        ...detected.extraHeaders,
      },
      body: JSON.stringify(reqBody),
    });
    if (!resp.ok) throw new Error(`OpenAI correction API ${resp.status}: ${await resp.text()}`);
    const json = (await resp.json()) as { choices: Array<{ message?: { content?: string; reasoning_content?: string } }> };
    const message = json.choices?.[0]?.message;
    return message?.content || message?.reasoning_content || "";
  }
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

  for (let beatIdx = 0; beatIdx < story.beats.length; beatIdx++) {
    const beat = story.beats[beatIdx];
    if (options?.skipBeatIds?.has(beat.id)) {
      console.log(`[dialogue-gen] (${beatIdx + 1}/${story.beats.length}) beat "${beat.id}" — skipped (cached)`);
      continue;
    }
    console.log(`[dialogue-gen] (${beatIdx + 1}/${story.beats.length}) generating beat "${beat.id}"...`);
    const systemPrompt = buildSystemPrompt(story, beat, turnsPerBeat);
    let rawTurns: RawTurn[] | undefined;

    const maxAttempts = 5;
    let lastError: unknown;
    let lastRawText: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        let rawText: string;
        if (lastRawText && attempt > 1) {
          // Previous attempt returned text but it failed to parse —
          // send the bad output back to the LLM for correction.
          const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
          console.warn(`[dialogue-gen] beat "${beat.id}" attempt ${attempt}: asking LLM to correct parse error...`);
          rawText = await callLlmWithCorrection(detected, systemPrompt, modelId, lastRawText, errMsg);
        } else {
          rawText = await callLlm(detected, systemPrompt, modelId);
        }
        lastRawText = rawText;
        rawTurns = parseDialogueTurns(rawText);
        break;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = msg.includes("429") || msg.includes("overloaded") || msg.includes("rate");
        const isParseError = msg.includes("Parse") || msg.includes("parse") || msg.includes("JSON")
          || msg.includes("Unterminated") || msg.includes("not a JSON");
        const isEmptyResponse = msg.includes("no text block") || msg.includes("no message content");
        if ((!isRateLimit && !isParseError && !isEmptyResponse) || attempt === maxAttempts) {
          throw new Error(
            `Failed to generate dialogue for beat "${beat.id}" after ${attempt} attempt(s): ${msg}`,
          );
        }
        if (isRateLimit || isEmptyResponse) {
          // Exponential backoff for rate limits and empty responses
          lastRawText = undefined; // no output to correct
          const delayMs = Math.min(2000 * 2 ** (attempt - 1), 30_000);
          console.warn(`[dialogue-gen] beat "${beat.id}" attempt ${attempt} ${isRateLimit ? "rate-limited" : "empty response"}, retrying in ${delayMs}ms...`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
        // For parse errors, lastRawText is preserved and correction is attempted next loop
      }
    }
    if (!rawTurns) {
      throw new Error(
        `Failed to generate dialogue for beat "${beat.id}": ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    }

    const entry: GeneratedDialogue = {
      beatId: beat.id,
      turns: assignTimestamps(rawTurns, beat.timestamp),
    };
    results.push(entry);
    options?.onBeatGenerated?.(entry, results);
  }

  return results;
}
