# Action Lexicon Resources

Source-of-truth inputs for the Phase-1 synonym-expanded action lexicon. Compiled
into `data/lexicon/action-lexicon.json` by `scripts/lexicon/build-lexicon.ts`.

## Files

| File | Purpose | Human-edited? |
|---|---|---|
| `seeds.json` | Canonical anchor lemmas per action family + external-resource pointers (WordNet synsets, Cilin codes). | Yes — rarely |
| `approvals.json` | Curation gate. Every candidate produced by expansion scripts must land in exactly one of `approved` / `rejected` / `ambiguous`. Build exits non-zero on unreviewed candidates. | Yes — whenever expansion produces new candidates |

## Rebuilding the compiled artifact

```bash
bun run lexicon:build    # emits data/lexicon/action-lexicon.json
bun run lexicon:check    # drift check: rebuild + diff vs committed artifact
```

## Commit-A baseline

At the initial commit, the lexicon is deliberately byte-equivalent to the
`HARDCODED_FALLBACK` in `src/runtime/speaker-normalization.ts` — 36 lemmas
across three families, each with manually-curated or lemmatizer-generated
inflections. `candidates` ≡ `approved`; no `rejected` / `ambiguous` entries yet.

Subsequent commits will wire `scripts/lexicon/expand-wordnet.ts` and
`scripts/lexicon/expand-cilin.ts` into `gatherCandidates()` inside
`build-lexicon.ts`, at which point `approvals.json` must be actively maintained.

## External resources (to be vendored in later commits)

| Source | Files | License | Notes |
|---|---|---|---|
| Princeton WordNet 3.1 | `resources/wordnet/dict/data.verb`, `index.verb` | WordNet License (Princeton) — permissive, commercial OK | Cited per license — see `resources/wordnet/README.md` when landed |
| 哈工大 同义词词林扩展版 | `resources/cilin/cilin-subset.txt` | Academic / research distribution | **Commercial use requires license review.** If MaidsClaw turns commercial, replace with Chinese WordNet (CWN) or hand-curated subset |

**Until these source files are vendored, the expansion scripts are skeletons
and `build-lexicon.ts` operates on seeds.json alone.**

## Approvals file format

```jsonc
{
  "version": 1,
  "<family>": {
    "approved":  { "en": [...], "cn": [...] },  // ships to runtime
    "rejected":  { "en": [...], "cn": [...] },  // permanently filtered out
    "ambiguous": { "en": [...], "cn": [...] }   // treated as rejected + logged distinctly
  },
  ...
}
```

Adding a new synonym:
1. Run `bun run lexicon:build`. Unreviewed candidates will be printed and the
   command will exit 2.
2. For each printed `family:lang:term`, decide `approved` / `rejected` /
   `ambiguous`, add it to `approvals.json`.
3. Re-run `bun run lexicon:build`. The artifact now reflects your decision.
4. Commit `approvals.json` + `data/lexicon/action-lexicon.json` together.

## Runtime kill-switch

If a release of the expanded lexicon causes regressions, set
`MAIDSCLAW_EXPANDED_LEXICON=off` in the deployed env. The speaker
normalizer will fall back to the 36-verb `HARDCODED_FALLBACK` without
needing a redeploy.
