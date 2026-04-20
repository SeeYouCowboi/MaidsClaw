import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

function collectTsFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (entry === "node_modules") continue;
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(...collectTsFiles(full));
		} else if (entry.endsWith(".ts")) {
			results.push(full);
		}
	}
	return results;
}

describe("areaStateArtifacts static-proof", () => {
	it("no production src files reference areaStateArtifacts outside approved shims", () => {
		const ALLOWED_FILES = [
			"projection-manager.ts",
			"contracts.ts",
			"rp-turn-contract.ts",
			"turn-service.ts",
			"thinker-worker.ts",
			"submit-rp-turn-tool.ts",
		];
		const files = collectTsFiles(join(process.cwd(), "src"));
		const violations: string[] = [];
		for (const file of files) {
			const basename = file.split(/[\\/]/).pop()!;
			if (ALLOWED_FILES.includes(basename)) continue;
			const contents = readFileSync(file, "utf-8");
			for (const [i, line] of contents.split("\n").entries()) {
				if (
					line.includes("areaStateArtifacts") &&
					!line.trimStart().startsWith("//")
				) {
					violations.push(`${file}:${i + 1}: ${line.trim()}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
