/**
 * Canonical-form helpers for entity pointer keys.
 *
 * Pointer keys are content-addressable retrieval anchors emitted by the
 * runtime (e.g. `item:silver_pocket_watch`, `char:alice`, `self:<agentId>`)
 * and stored on episodes and cognition records. These helpers apply format-
 * level normalization (NFKC + lowercase + kind-prefix aliasing) and dedup.
 * They do NOT merge semantically distinct surface forms — see the
 * `canonical_entity_id` pipeline for that.
 */

const KIND_ALIASES: Record<string, string> = {
  person: "char",
  character: "char",
  npc: "char",
  place: "loc",
  location: "loc",
  area: "loc",
  thing: "item",
  object: "item",
};

export function normalizePointerKey(raw: string): string {
  if (typeof raw !== "string") return "";
  const s = raw.normalize("NFKC").trim();
  if (s.length === 0) return "";
  const colonIdx = s.indexOf(":");
  if (colonIdx === -1) {
    return s.toLowerCase();
  }
  const rawKind = s.slice(0, colonIdx).trim().toLowerCase();
  const body = s.slice(colonIdx + 1).trim();
  if (rawKind.length === 0 || body.length === 0) return "";
  const kind = KIND_ALIASES[rawKind] ?? rawKind;
  return `${kind}:${body.toLowerCase()}`;
}

export function normalizePointerKeys(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of raw) {
    const n = normalizePointerKey(key);
    if (n.length === 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
