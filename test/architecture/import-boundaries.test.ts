import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { join, resolve, relative } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

const FORBIDDEN_IMPORTERS = [
  "src/runtime",
  "src/bootstrap",
  "src/gateway",
  "src/app",
] as const;

const FORBIDDEN_TARGET = "terminal-cli";

const IMPORT_PATTERNS = [
  /from\s+["'][^"']*terminal-cli[^"']*["']/,
  /import\s*\(\s*["'][^"']*terminal-cli[^"']*["']\s*\)/,
  /require\s*\(\s*["'][^"']*terminal-cli[^"']*["']\s*\)/,
];

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scanDirectory(dir: string): Violation[] {
  const violations: Violation[] = [];
  const glob = new Glob("**/*.ts");
  const absDir = join(PROJECT_ROOT, dir);

  for (const match of glob.scanSync({ cwd: absDir, absolute: true })) {
    if (match.endsWith(".test.ts") || match.endsWith(".d.ts")) continue;

    const content = readFileSync(match, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of IMPORT_PATTERNS) {
        if (pattern.test(line)) {
          const relPath = relative(PROJECT_ROOT, match).split("\\").join("/");
          violations.push({
            file: relPath,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }
  }

  return violations;
}

describe("Import boundary: app/runtime/bootstrap/gateway must not depend on terminal-cli", () => {
  for (const modulePath of FORBIDDEN_IMPORTERS) {
    it(`${modulePath} has no imports from ${FORBIDDEN_TARGET}`, () => {
      const violations = scanDirectory(modulePath);

      if (violations.length > 0) {
        const details = violations
          .map((v) => `  ${v.file}:${v.line} → ${v.text}`)
          .join("\n");
        throw new Error(
          `Found ${violations.length} forbidden import(s) from "${FORBIDDEN_TARGET}" in ${modulePath}:\n${details}`,
        );
      }

      expect(violations).toHaveLength(0);
    });
  }

  it("terminal-cli directory exists (sanity check)", () => {
    const deepGlob = new Glob("**/*.ts");
    const terminalDir = join(PROJECT_ROOT, "src", FORBIDDEN_TARGET);
    let deepCount = 0;
    for (const _match of deepGlob.scanSync({ cwd: terminalDir, absolute: true })) {
      deepCount++;
    }
    expect(deepCount).toBeGreaterThan(0);
  });
});
