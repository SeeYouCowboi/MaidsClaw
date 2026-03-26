# Sisyphus Doc Cleanup

Use this skill when `.sisyphus` has accumulated stale plan byproducts and you need to safely prune outdated `evidence` or `notepads` artifacts without touching still-active planning material.

## When to use

- A user deleted or replaced one or more files under `.sisyphus/plans`.
- `.sisyphus/evidence` contains lots of artifacts from old plans.
- `.sisyphus/notepads` contains directories whose matching plan no longer exists.
- You want a conservative cleanup that keeps artifacts still referenced by surviving plans or drafts.

## Source of truth

Treat these as the only canonical keep-roots:

- `.sisyphus/plans/`
- `.sisyphus/drafts/`

Anything under `.sisyphus/evidence` or `.sisyphus/notepads` should be considered disposable unless it is still justified by those surviving plans or drafts.

## Cleanup policy

### Keep

- Any artifact explicitly referenced by a surviving file in `.sisyphus/plans` or `.sisyphus/drafts`.
- Any file under an explicitly referenced subdirectory, such as `.sisyphus/evidence/final-qa/`.
- Any notepad directory that still has a matching surviving plan name.

### Delete

- Evidence files that are no longer referenced by any surviving plan or draft.
- Placeholder evidence with no signal:
  - empty files,
  - single-line command banners like `bun test v...`,
  - lone exit markers like `EXIT: 0` or `BUILD: exit 0`.
- Transient SQLite sidecars such as `*.sqlite-wal` and `*.sqlite-shm`.
- Notepad directories with no matching surviving plan and no remaining plan/draft references.
- Placeholder note files containing only headers / `None yet` style filler.

### Do not treat as keep-signals

- Generic collection mentions like `.sisyphus/evidence/`.
- Template references like `.sisyphus/evidence/task-{N}-{slug}.txt` or wildcard references like `audit-*.md`.

Those describe storage conventions, not specific artifacts that must be preserved.

## Commands

Dry-run first:

```bash
bun run check:sisyphus-docs
```

Apply cleanup:

```bash
bun run cleanup:sisyphus-docs
```

Repository validation after cleanup:

```bash
bun run check:sisyphus-docs
bun run build
bun test
```

## Implementation notes

- The cleanup logic lives in `scripts/cleanup-sisyphus-docs.ts`.
- The script is intentionally reference-driven: surviving plans/drafts define what is still alive.
- Prefer rerunning the script after plan deletions rather than hand-deleting dozens of files.
- If a user just removed old plans, rerun the cleanup immediately; orphaned evidence/notepads often appear in bulk.

## Expected workflow

1. Inspect `.sisyphus/plans` to see which plans still exist.
2. Run `bun run check:sisyphus-docs`.
3. Confirm the candidate list matches the plan churn.
4. Run `bun run cleanup:sisyphus-docs`.
5. Re-run `bun run check:sisyphus-docs` until it reports zero candidates.
6. Run `bun run build` and `bun test`.

## Cautions

- Do not delete surviving plan files as part of this skill.
- Do not preserve orphaned evidence just because it looks detailed; if no surviving plan/draft still points to it, it is historical residue.
- If you notice unrelated user changes elsewhere in the repo, leave them alone and scope the cleanup to `.sisyphus` plus the cleanup script / script wiring.
