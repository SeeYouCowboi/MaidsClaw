import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";

const ALLOWED_FILES = new Set([
  "src/memory/schema.ts",
  "test/memory/schema.test.ts",
  "test/memory/contracts/graph-node-ref.test.ts",
  "test/memory/legacy-literal-gate.test.ts",
]);

const IGNORED_PREFIXES = [".sisyphus/", ".claude/", "docs/"] as const;

const FORBIDDEN_TOKENS = [
  "create_private_",
  "private_event_ids",
  "private_belief_ids",
  "private_event",
  "private_belief",
  "agent_fact_overlay",
  "AgentFactOverlay",
] as const;

const BINARY_EXTENSIONS = new Set([".sqlite", ".db", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".wasm"]);

function listTrackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }

  return result.stdout.split("\0").filter(Boolean);
}

function isLikelyBinary(relativePath: string): boolean {
  if (BINARY_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
    return true;
  }

  const absolutePath = resolve(process.cwd(), relativePath);
  // Skip files that have been deleted but not yet committed
  if (!existsSync(absolutePath)) {
    return true; // Treat missing files as binary to skip content scanning
  }

  const buffer = readFileSync(absolutePath);
  return buffer.includes(0);
}

describe("legacy literal gate", () => {
  it("rejects forbidden legacy memory literals and dropped overlay names outside the approved history files", () => {
    const violations: string[] = [];

    for (const relativePath of listTrackedFiles()) {
      if (
        ALLOWED_FILES.has(relativePath) ||
        IGNORED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ||
        isLikelyBinary(relativePath)
      ) {
        continue;
      }

      const absolutePath = resolve(process.cwd(), relativePath);
      // Skip files that have been deleted but not yet committed
      if (!existsSync(absolutePath)) {
        continue;
      }

      const content = readFileSync(absolutePath, "utf8");
      const hits = FORBIDDEN_TOKENS.filter((token) => content.includes(token));
      if (hits.length > 0) {
        violations.push(`${relativePath}: ${hits.join(", ")}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
