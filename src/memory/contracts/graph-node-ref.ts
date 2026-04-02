import { NODE_REF_KINDS, type NodeRefKind } from "../types.js";

export type GraphNodeRef = {
  kind: NodeRefKind;
  id: string;
};

/** Regex pattern for validating node_ref strings (e.g., "assertion:123") */
export const NODE_REF_REGEX = /^(assertion|evaluation|commitment|event|entity|fact):(.+)$/;

export function parseGraphNodeRef(raw: string): GraphNodeRef {
  const colonIndex = raw.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid node ref format: ${raw}`);
  }

  const kind = raw.slice(0, colonIndex) as NodeRefKind;
  const id = raw.slice(colonIndex + 1);

  if (!(NODE_REF_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown node ref kind: ${kind}`);
  }

  return { kind, id };
}

export function serializeGraphNodeRef(ref: GraphNodeRef): string {
  return `${ref.kind}:${ref.id}`;
}
