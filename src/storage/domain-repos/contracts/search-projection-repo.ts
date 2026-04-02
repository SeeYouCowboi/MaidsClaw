import type { NodeRef } from "../../../memory/types.js";

export type SearchProjectionScope = "private" | "area" | "world" | "cognition";

export interface SearchProjectionRepo {
  syncSearchDoc(
    scope: "private" | "area" | "world",
    sourceRef: NodeRef,
    content: string,
    agentId?: string,
    locationEntityId?: number,
  ): Promise<number>;
  removeSearchDoc(scope: "private" | "area" | "world", sourceRef: NodeRef): Promise<void>;
  rebuildForScope(scope: SearchProjectionScope, agentId?: string): Promise<void>;
}
