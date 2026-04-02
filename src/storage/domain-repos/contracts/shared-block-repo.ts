import type {
  SharedBlock,
  SharedBlockSection,
} from "../../../memory/shared-blocks/shared-block-repo.js";

export type SharedBlockAttachment = {
  id: number;
  blockId: number;
  targetKind: "agent";
  targetId: string;
  attachedByAgentId: string;
  attachedAt: number;
};

export interface SharedBlockRepo {
  createBlock(title: string, createdByAgentId: string, options?: { retrievalOnly?: boolean }): Promise<SharedBlock>;
  getBlock(blockId: number): Promise<SharedBlock | undefined>;
  getSections(blockId: number): Promise<SharedBlockSection[]>;
  getSection(blockId: number, sectionPath: string): Promise<SharedBlockSection | undefined>;
  upsertSection(blockId: number, sectionPath: string, content: string, title?: string): Promise<void>;
  deleteSection(blockId: number, sectionPath: string): Promise<boolean>;
  renameSection(blockId: number, fromPath: string, toPath: string): Promise<boolean>;
  setTitle(blockId: number, title: string): Promise<void>;
  sectionExists(blockId: number, sectionPath: string): Promise<boolean>;
  buildSnapshotJson(blockId: number): Promise<string>;
  writeSnapshot(blockId: number, snapshotSeq: number): Promise<void>;
  getAttachedBlockIds(targetKind: string, targetId: string): Promise<number[]>;

  /** Check whether agentId is owner or admin of the given block. */
  isBlockAdmin(blockId: number, agentId: string): Promise<boolean>;

  /**
   * Attach a block to a target agent. Returns the attachment record.
   * If the attachment already exists, returns the existing record.
   */
  attachBlock(
    blockId: number,
    targetId: string,
    attachedByAgentId: string,
  ): Promise<SharedBlockAttachment>;

  /** Detach a block from a target agent. Returns true if a row was deleted. */
  detachBlock(blockId: number, targetId: string): Promise<boolean>;

  /** List all attachments for a given target. */
  getAttachments(targetKind: "agent", targetId: string): Promise<SharedBlockAttachment[]>;
}
