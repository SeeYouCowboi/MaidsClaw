import { MAX_INTEGER, NODE_REF_KINDS, type NodeRef, type NodeRefKind } from "./types.js";

export { MAX_INTEGER } from "./types.js";

export const VisibilityScope = { AREA_VISIBLE: "area_visible", WORLD_PUBLIC: "world_public" } as const;
export const SQL_AREA_VISIBLE = `visibility_scope = '${VisibilityScope.AREA_VISIBLE}'` as const;
export const MemoryScope = { SHARED_PUBLIC: "shared_public", PRIVATE_OVERLAY: "private_overlay" } as const;
export const EventCategory = {
  SPEECH: "speech",
  ACTION: "action",
  OBSERVATION: "observation",
  STATE_CHANGE: "state_change",
} as const;
export const ProjectionClass = { NONE: "none", AREA_CANDIDATE: "area_candidate" } as const;
export const PromotionClass = { NONE: "none", WORLD_CANDIDATE: "world_candidate" } as const;
export const SurfacingClassification = {
  PUBLIC_MANIFESTATION: "public_manifestation",
  LATENT_STATE_UPDATE: "latent_state_update",
  PRIVATE_ONLY: "private_only",
} as const;

export function makeNodeRef(kind: NodeRefKind, id: number): NodeRef {
  if (!(NODE_REF_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid node ref kind: ${kind}`);
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid node ref id: ${id}`);
  }
  return `${kind}:${id}` as NodeRef;
}
