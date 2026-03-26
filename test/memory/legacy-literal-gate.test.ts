import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";

const ALLOWED_FILES = new Set([
  "src/memory/schema.ts",
  "test/memory/schema.test.ts",
  "src/memory/contracts/graph-node-ref.test.ts",
]);

const IGNORED_PREFIXES = [".sisyphus/", ".claude/", "docs/"] as const;

const FORBIDDEN_TOKENS = [
  "create_private_",
  "private_event_ids",
  "private_belief_ids",
  "private_event",
  "private_belief",
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

  const buffer = readFileSync(resolve(process.cwd(), relativePath));
  return buffer.includes(0);
}

describe("legacy literal gate", () => {
  it("rejects forbidden legacy memory literals outside the approved history files", () => {
    const violations: string[] = [];

    for (const relativePath of listTrackedFiles()) {
      if (
        ALLOWED_FILES.has(relativePath) ||
        IGNORED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ||
        isLikelyBinary(relativePath)
      ) {
        continue;
      }

      const content = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      const hits = FORBIDDEN_TOKENS.filter((token) => content.includes(token));
      if (hits.length > 0) {
        violations.push(`${relativePath}: ${hits.join(", ")}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
