import type {
  SharedBlock,
  SharedBlockSection,
} from "../../../memory/shared-blocks/shared-block-repo.js";

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
}
