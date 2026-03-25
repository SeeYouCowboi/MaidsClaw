import { ALL_KNOWN_NODE_REF_KINDS, type AnyNodeRefKind } from "../types.js";

export type GraphNodeRef = {
  kind: AnyNodeRefKind;
  id: string;
};

export function parseGraphNodeRef(raw: string): GraphNodeRef {
  const colonIndex = raw.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid node ref format: ${raw}`);
  }

  const kind = raw.slice(0, colonIndex) as AnyNodeRefKind;
  const id = raw.slice(colonIndex + 1);

  if (!(ALL_KNOWN_NODE_REF_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown node ref kind: ${kind}`);
  }

  return { kind, id };
}

export function serializeGraphNodeRef(ref: GraphNodeRef): string {
  return `${ref.kind}:${ref.id}`;
}
