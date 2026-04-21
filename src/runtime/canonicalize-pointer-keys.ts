import type { AliasRepo } from "../storage/domain-repos/contracts/alias-repo.js";
import type {
  CognitionEntityRef,
  CognitionOp,
  CommitmentRecord,
  EpisodeEntityRef,
  PrivateEpisodeArtifact,
} from "./rp-turn-contract.js";

type AliasResolver = Pick<AliasRepo, "resolveAlias" | "findEntityById">;

type PointerCanonicalizationParams = {
  agentId: string;
  aliasRepo?: AliasResolver;
};

function normalizePointerAlias(value: string): string {
  return value.normalize("NFC").trim();
}

function dedupeEntityRefs<T extends { kind: string; value: string }>(
  refs: T[],
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}

async function resolveCanonicalPointerKey(
  pointerKey: string,
  params: PointerCanonicalizationParams,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (!params.aliasRepo) {
    return null;
  }

  const normalizedAlias = normalizePointerAlias(pointerKey);
  if (normalizedAlias.length === 0) {
    return null;
  }

  const cacheKey = `${params.agentId}::${normalizedAlias}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  const canonicalEntityId = await params.aliasRepo.resolveAlias(
    normalizedAlias,
    params.agentId,
  );
  if (canonicalEntityId == null) {
    cache.set(cacheKey, null);
    return null;
  }

  const canonicalEntity = await params.aliasRepo.findEntityById(canonicalEntityId);
  const canonicalPointerKey =
    canonicalEntity?.pointer_key &&
    canonicalEntity.pointer_key.trim().length > 0
      ? canonicalEntity.pointer_key
      : null;
  cache.set(cacheKey, canonicalPointerKey);
  return canonicalPointerKey;
}

async function canonicalizeEntityRef(
  ref: CognitionEntityRef,
  params: PointerCanonicalizationParams,
  cache: Map<string, string | null>,
): Promise<CognitionEntityRef> {
  if (ref.kind !== "pointer_key") {
    return ref;
  }

  const canonicalPointerKey = await resolveCanonicalPointerKey(
    ref.value,
    params,
    cache,
  );
  if (!canonicalPointerKey || canonicalPointerKey === ref.value) {
    return ref;
  }
  return {
    kind: "pointer_key",
    value: canonicalPointerKey,
  };
}

async function canonicalizeCommitmentTarget(
  target: CommitmentRecord["target"],
  params: PointerCanonicalizationParams,
  cache: Map<string, string | null>,
): Promise<CommitmentRecord["target"]> {
  if (typeof target !== "object" || target == null) {
    return target;
  }

  if ("action" in target) {
    if (!target.target) {
      return target;
    }
    const canonicalTarget = await canonicalizeEntityRef(target.target, params, cache);
    if (canonicalTarget === target.target) {
      return target;
    }
    return {
      ...target,
      target: canonicalTarget,
    };
  }

  const canonicalSubject = await canonicalizeEntityRef(target.subject, params, cache);
  const canonicalObjectRef = await canonicalizeEntityRef(
    target.object.ref,
    params,
    cache,
  );
  if (
    canonicalSubject === target.subject &&
    canonicalObjectRef === target.object.ref
  ) {
    return target;
  }
  return {
    ...target,
    subject: canonicalSubject,
    object: {
      ...target.object,
      ref: canonicalObjectRef,
    },
  };
}

/**
 * Deterministically rewrites pointer_key refs in thinker cognition ops based on
 * previously judged aliases.
 */
export async function canonicalizePointerKeysInCognitionOps(params: {
  ops: CognitionOp[];
  agentId: string;
  aliasRepo?: AliasResolver;
}): Promise<CognitionOp[]> {
  if (!params.aliasRepo || params.ops.length === 0) {
    return params.ops;
  }

  const resolverParams: PointerCanonicalizationParams = {
    agentId: params.agentId,
    aliasRepo: params.aliasRepo,
  };
  const cache = new Map<string, string | null>();
  const rewrittenOps: CognitionOp[] = [];

  for (const op of params.ops) {
    if (op.op === "retract") {
      rewrittenOps.push(op);
      continue;
    }

    if (op.record.kind === "assertion") {
      const assertion = op.record;
      const holderId = await canonicalizeEntityRef(
        assertion.holderId,
        resolverParams,
        cache,
      );
      const entityRefs = await Promise.all(
        assertion.entityRefs.map((ref) =>
          canonicalizeEntityRef(ref, resolverParams, cache),
        ),
      );
      const dedupedEntityRefs = dedupeEntityRefs(entityRefs);
      rewrittenOps.push({
        ...op,
        record:
          holderId === assertion.holderId &&
          dedupedEntityRefs.length === assertion.entityRefs.length &&
          dedupedEntityRefs.every((ref, idx) => ref === assertion.entityRefs[idx])
            ? assertion
            : {
                ...assertion,
                holderId,
                entityRefs: dedupedEntityRefs,
              },
      });
      continue;
    }

    if (
      op.record.kind === "evaluation" &&
      "value" in op.record.target &&
      op.record.target.kind === "pointer_key"
    ) {
      const target = await canonicalizeEntityRef(
        op.record.target,
        resolverParams,
        cache,
      );
      rewrittenOps.push({
        ...op,
        record:
          target === op.record.target
            ? op.record
            : {
                ...op.record,
                target,
              },
      });
      continue;
    }

    if (op.record.kind === "commitment") {
      const target = await canonicalizeCommitmentTarget(
        op.record.target,
        resolverParams,
        cache,
      );
      rewrittenOps.push({
        ...op,
        record:
          target === op.record.target
            ? op.record
            : {
                ...op.record,
                target,
              },
      });
      continue;
    }

    rewrittenOps.push(op);
  }

  return rewrittenOps;
}

async function canonicalizeEpisodeEntityRef(
  ref: EpisodeEntityRef,
  params: PointerCanonicalizationParams,
  cache: Map<string, string | null>,
): Promise<EpisodeEntityRef> {
  if (ref.kind !== "pointer_key") {
    return ref;
  }
  const canonicalPointerKey = await resolveCanonicalPointerKey(
    ref.value,
    params,
    cache,
  );
  if (!canonicalPointerKey || canonicalPointerKey === ref.value) {
    return ref;
  }
  return {
    kind: "pointer_key",
    value: canonicalPointerKey,
  };
}

/**
 * Rewrites pointer_key refs on private episode artifacts prior to projection
 * so `entity_pointer_keys` stays canonicalized in storage.
 */
export async function canonicalizePointerKeysInEpisodes(params: {
  episodes: PrivateEpisodeArtifact[];
  agentId: string;
  aliasRepo?: AliasResolver;
}): Promise<PrivateEpisodeArtifact[]> {
  if (!params.aliasRepo || params.episodes.length === 0) {
    return params.episodes;
  }

  const resolverParams: PointerCanonicalizationParams = {
    agentId: params.agentId,
    aliasRepo: params.aliasRepo,
  };
  const cache = new Map<string, string | null>();
  const rewritten: PrivateEpisodeArtifact[] = [];

  for (const episode of params.episodes) {
    if (!episode.entityRefs || episode.entityRefs.length === 0) {
      rewritten.push(episode);
      continue;
    }

    const refs = await Promise.all(
      episode.entityRefs.map((ref) =>
        canonicalizeEpisodeEntityRef(ref, resolverParams, cache),
      ),
    );
    const deduped = dedupeEntityRefs(refs);
    const unchanged =
      deduped.length === episode.entityRefs.length &&
      deduped.every((ref, index) => ref === episode.entityRefs![index]);
    rewritten.push(
      unchanged
        ? episode
        : {
            ...episode,
            entityRefs: deduped,
          },
    );
  }

  return rewritten;
}
