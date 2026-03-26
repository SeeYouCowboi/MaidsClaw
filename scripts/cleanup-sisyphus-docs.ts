#!/usr/bin/env bun
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

type ArtifactBucket = "evidence" | "notepad";
type ArtifactKind = "file" | "directory";

type CleanupCandidate = {
  absolutePath: string;
  relativePath: string;
  bucket: ArtifactBucket;
  kind: ArtifactKind;
  reason: string;
};

type PreserveReference = {
  absolutePath: string;
  kind: ArtifactKind;
};

const repoRoot = path.resolve(import.meta.dir, "..");
const sisyphusRoot = path.join(repoRoot, ".sisyphus");
const plansRoot = path.join(sisyphusRoot, "plans");
const draftsRoot = path.join(sisyphusRoot, "drafts");
const evidenceRoot = path.join(sisyphusRoot, "evidence");
const notepadsRoot = path.join(sisyphusRoot, "notepads");
const applyChanges = process.argv.includes("--apply");

function toRepoRelative(absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function trimTrailingPunctuation(rawRef: string): string {
  return rawRef.replace(/[),.;:]+$/u, "");
}

function isTemplateReference(rawRef: string): boolean {
  return /[{}[\]*]/u.test(rawRef);
}

function isCollectionRootReference(rawRef: string): boolean {
  return rawRef === ".sisyphus/evidence/" || rawRef === ".sisyphus/evidence"
    || rawRef === ".sisyphus/notepads/" || rawRef === ".sisyphus/notepads";
}

function normalizeNotepadLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[()]/gu, "")
    .replace(/[—–]/gu, "-")
    .replace(/^[*-]\s*/u, "")
    .trim();
}

function isPlaceholderNotepad(text: string): boolean {
  const contentLines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (contentLines.length === 0) {
    return true;
  }

  return contentLines.every((line) => {
    const normalized = normalizeNotepadLine(line);
    return normalized === "none yet" || normalized === "none yet - updated as issues are discovered";
  });
}

function isPlaceholderEvidence(text: string): boolean {
  const trimmed = normalizeText(text);
  if (trimmed.length === 0) {
    return true;
  }

  return (
    /^bun test v[^\n]+$/u.test(trimmed) ||
    /^exit:\s*\d+$/iu.test(trimmed) ||
    /^build:\s*exit\s*\d+$/iu.test(trimmed)
  );
}

function isTransientSqliteSidecar(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".sqlite-shm") || lower.endsWith(".sqlite-wal");
}

async function walkFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walkFiles(fullPath));
        continue;
      }

      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    return files;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function collectExplicitArtifactReferences(): Promise<PreserveReference[]> {
  const references = new Map<string, PreserveReference>();

  for (const root of [plansRoot, draftsRoot]) {
    for (const filePath of await walkFiles(root)) {
      if (!filePath.endsWith(".md")) {
        continue;
      }

      const text = await readFile(filePath, "utf8");
      for (const match of text.matchAll(/\.sisyphus\/(?:evidence|notepads)\/[^\s`"'()<>]+/gu)) {
        const rawRef = trimTrailingPunctuation(match[0]);
        if (isTemplateReference(rawRef) || isCollectionRootReference(rawRef)) {
          continue;
        }

        const absolutePath = path.resolve(repoRoot, rawRef.replaceAll("/", path.sep));
        let kind: ArtifactKind = rawRef.endsWith("/") ? "directory" : "file";

        if (kind === "file") {
          try {
            kind = (await lstat(absolutePath)).isDirectory() ? "directory" : "file";
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
              throw error;
            }
          }
        }

        references.set(`${kind}:${absolutePath}`, { absolutePath, kind });
      }
    }
  }

  return Array.from(references.values());
}

function isPreservedPath(absolutePath: string, references: PreserveReference[]): boolean {
  return references.some((reference) =>
    reference.kind === "file"
      ? reference.absolutePath === absolutePath
      : absolutePath === reference.absolutePath || absolutePath.startsWith(`${reference.absolutePath}${path.sep}`),
  );
}

function hasPreservedDescendant(directoryPath: string, references: PreserveReference[]): boolean {
  return references.some((reference) =>
    reference.absolutePath === directoryPath || reference.absolutePath.startsWith(`${directoryPath}${path.sep}`),
  );
}

async function collectEvidenceCandidates(references: PreserveReference[]): Promise<CleanupCandidate[]> {
  const candidates: CleanupCandidate[] = [];

  for (const filePath of await walkFiles(evidenceRoot)) {
    if (isPreservedPath(filePath, references)) {
      continue;
    }

    if (isTransientSqliteSidecar(filePath)) {
      candidates.push({
        absolutePath: filePath,
        relativePath: toRepoRelative(filePath),
        bucket: "evidence",
        kind: "file",
        reason: "transient sqlite sidecar",
      });
      continue;
    }

    const extension = path.extname(filePath).toLowerCase();
    const textLike = extension === ".txt" || extension === ".md" || extension === ".log";
    const text = textLike ? await readFile(filePath, "utf8") : "";
    const trimmed = textLike ? normalizeText(text) : "";

    if (textLike && trimmed.length === 0) {
      candidates.push({
        absolutePath: filePath,
        relativePath: toRepoRelative(filePath),
        bucket: "evidence",
        kind: "file",
        reason: "orphaned empty artifact",
      });
      continue;
    }

    if (textLike && isPlaceholderEvidence(text)) {
      candidates.push({
        absolutePath: filePath,
        relativePath: toRepoRelative(filePath),
        bucket: "evidence",
        kind: "file",
        reason: "orphaned single-line command banner or exit marker",
      });
      continue;
    }

    candidates.push({
      absolutePath: filePath,
      relativePath: toRepoRelative(filePath),
      bucket: "evidence",
      kind: "file",
      reason: textLike
        ? "orphaned evidence not referenced by any surviving plan or draft"
        : "orphaned evidence asset not referenced by any surviving plan or draft",
    });
  }

  return candidates;
}

async function collectNotepadCandidates(references: PreserveReference[]): Promise<CleanupCandidate[]> {
  const candidates: CleanupCandidate[] = [];
  const planNames = new Set(
    (await readdir(plansRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.basename(entry.name, path.extname(entry.name)).toLowerCase()),
  );

  const directories = await readdir(notepadsRoot, { withFileTypes: true });
  for (const directory of directories) {
    if (!directory.isDirectory()) {
      continue;
    }

    const directoryPath = path.join(notepadsRoot, directory.name);
    const hasMatchingPlan = planNames.has(directory.name.toLowerCase());
    const directoryPreserved = hasPreservedDescendant(directoryPath, references);

    if (!hasMatchingPlan && !directoryPreserved) {
      candidates.push({
        absolutePath: directoryPath,
        relativePath: toRepoRelative(directoryPath),
        bucket: "notepad",
        kind: "directory",
        reason: "orphaned notepad directory with no surviving plan or draft",
      });
      continue;
    }

    for (const filePath of await walkFiles(directoryPath)) {
      if (isPreservedPath(filePath, references) || path.extname(filePath).toLowerCase() !== ".md") {
        continue;
      }

      const text = await readFile(filePath, "utf8");
      if (!isPlaceholderNotepad(text)) {
        continue;
      }

      candidates.push({
        absolutePath: filePath,
        relativePath: toRepoRelative(filePath),
        bucket: "notepad",
        kind: "file",
        reason: "placeholder note with no substantive content",
      });
    }
  }

  return candidates;
}

async function pruneEmptyDirectories(root: string): Promise<string[]> {
  const removed: string[] = [];

  async function visit(current: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return true;
      }
      throw error;
    }

    let hasFiles = false;

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const empty = await visit(fullPath);
        if (!empty) {
          hasFiles = true;
        }
        continue;
      }

      hasFiles = true;
    }

    if (!hasFiles && current !== root) {
      await rm(current, { recursive: true, force: true });
      removed.push(toRepoRelative(current));
      return true;
    }

    return !hasFiles;
  }

  await visit(root);
  return removed;
}

function logCandidates(candidates: CleanupCandidate[]): void {
  for (const candidate of candidates) {
    const prefix = applyChanges ? "DELETE" : "WOULD DELETE";
    console.log(`${prefix} ${candidate.relativePath} (${candidate.bucket}/${candidate.kind}: ${candidate.reason})`);
  }
}

function logReasonSummary(candidates: CleanupCandidate[]): void {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.reason, (counts.get(candidate.reason) ?? 0) + 1);
  }

  for (const [reason, count] of counts.entries()) {
    console.log(`  - ${reason}: ${count}`);
  }
}

async function main(): Promise<void> {
  const references = await collectExplicitArtifactReferences();
  const evidenceCandidates = await collectEvidenceCandidates(references);
  const notepadCandidates = await collectNotepadCandidates(references);
  const candidates = [...evidenceCandidates, ...notepadCandidates].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );

  console.log(`Referenced artifacts preserved: ${references.length}`);
  console.log(`Cleanup mode: ${applyChanges ? "apply" : "dry-run"}`);
  console.log(`Candidates: ${candidates.length}`);

  if (candidates.length > 0) {
    console.log("Reasons:");
    logReasonSummary(candidates);
    console.log("");
    logCandidates(candidates);
  }

  if (!applyChanges) {
    console.log("");
    console.log("Dry run only. Re-run with --apply to delete the candidates.");
    return;
  }

  for (const candidate of candidates) {
    await rm(candidate.absolutePath, { recursive: candidate.kind === "directory", force: true });
  }

  const removedDirs = [
    ...await pruneEmptyDirectories(evidenceRoot),
    ...await pruneEmptyDirectories(notepadsRoot),
  ].sort((left, right) => left.localeCompare(right));

  console.log("");
  console.log(`Deleted ${candidates.length} files.`);
  if (removedDirs.length > 0) {
    console.log(`Removed ${removedDirs.length} empty directories.`);
    for (const directory of removedDirs) {
      console.log(`DELETE DIR ${directory}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
