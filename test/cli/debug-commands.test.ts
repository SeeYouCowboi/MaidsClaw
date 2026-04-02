import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerDebugCommands } from "../../src/terminal-cli/commands/debug.js";
import { dispatch, resetCommands } from "../../src/terminal-cli/parser.js";
import type { JsonEnvelope } from "../../src/terminal-cli/types.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const tempRoots: string[] = [];
let savedAnthropicKey: string | undefined;
let savedOpenAIKey: string | undefined;

function createTempDir(): string {
	const tempRoot = join(
		import.meta.dir,
		`../../.tmp-debug-cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	mkdirSync(tempRoot, { recursive: true });
	tempRoots.push(tempRoot);
	return tempRoot;
}

function cleanupTempDirs(): void {
	for (const tempRoot of tempRoots.splice(0, tempRoots.length)) {
		try {
			rmSync(tempRoot, { recursive: true, force: true });
		} catch {}
	}
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		chunks.push(
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
		);
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

function parseJsonOutput(raw: string): JsonEnvelope {
	const line = raw.trim().split("\n")[0];
	if (!line) {
		throw new Error("Expected JSON output line");
	}
	return JSON.parse(line) as JsonEnvelope;
}

describe.skipIf(skipPgTests)("debug commands", () => {
	beforeEach(() => {
		resetCommands();
		registerDebugCommands();
		savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
		savedOpenAIKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-openai-test";
		delete process.env.ANTHROPIC_API_KEY;
	});

	afterEach(() => {
		cleanupTempDirs();
		if (savedOpenAIKey !== undefined) {
			process.env.OPENAI_API_KEY = savedOpenAIKey;
		} else {
			delete process.env.OPENAI_API_KEY;
		}
		if (savedAnthropicKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it("debug trace export rejects --unsafe-raw without local context", async () => {
		const tmpRoot = createTempDir();

		const raw = await captureStdout(async () => {
			await dispatch([
				"--json",
				"--cwd",
				tmpRoot,
				"debug",
				"trace",
				"export",
				"--request",
				"req-trace-raw",
				"--unsafe-raw",
			]);
		});

		const envelope = parseJsonOutput(raw);
		expect(envelope.ok).toBe(false);
		expect((envelope.error as { code?: string })?.code).toBeDefined();
	});
});
