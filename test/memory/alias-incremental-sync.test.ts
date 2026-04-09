import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { AliasService } from "../../src/memory/alias";
import * as cjkSegmenter from "../../src/memory/cjk-segmenter";
import type { AliasRepo } from "../../src/storage/domain-repos/contracts/alias-repo";
import type { EntityAlias } from "../../src/memory/types";

/**
 * GAP-4 §7 — runtime alias create-side incremental jieba sync.
 *
 * Validates that `AliasService.createAlias` only invokes `loadUserDict`
 * on the cjk-segmenter module when (a) the alias is shared (no owner
 * agent id) AND (b) the alias contains CJK characters. Private aliases
 * and Latin-only shared aliases must NOT touch the global jieba dict.
 *
 * `loadUserDict` is spied (not module-mocked) so the spy is scoped to
 * this file and does not leak into sibling test files. The actual
 * cjk-segmenter module is preserved — `loadUserDict` itself is a no-op
 * when jieba is not initialized, so the spy can run safely with or
 * without `@node-rs/jieba` installed locally.
 */

function makeRepoStub(createReturn: number = 42): AliasRepo {
  return {
    async resolveAlias(): Promise<number | null> {
      return null;
    },
    async resolveAliases(): Promise<Map<string, number | null>> {
      return new Map();
    },
    async createAlias(): Promise<number> {
      return createReturn;
    },
    async getAliasesForEntity(): Promise<EntityAlias[]> {
      return [];
    },
    async findEntityById() {
      return null;
    },
    async findEntityByPointerKey() {
      return null;
    },
    async listSharedAliasStrings(): Promise<string[]> {
      return [];
    },
    async listPrivateAliasStrings(): Promise<string[]> {
      return [];
    },
  };
}

describe("AliasService.createAlias — GAP-4 §7 incremental jieba sync", () => {
  let loadUserDictSpy: ReturnType<typeof spyOn<typeof cjkSegmenter, "loadUserDict">>;

  beforeEach(() => {
    loadUserDictSpy = spyOn(cjkSegmenter, "loadUserDict").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    loadUserDictSpy.mockRestore();
  });

  it("calls loadUserDict for a shared CJK alias", async () => {
    const service = new AliasService(makeRepoStub());

    const id = await service.createAlias(1, "小红同学", undefined, undefined);

    expect(id).toBe(42);
    expect(loadUserDictSpy).toHaveBeenCalledTimes(1);
    expect(loadUserDictSpy).toHaveBeenCalledWith(["小红同学"]);
  });

  it("does NOT call loadUserDict for a private CJK alias (scope isolation)", async () => {
    const service = new AliasService(makeRepoStub());

    await service.createAlias(1, "小红同学", undefined, "agent_a");

    expect(loadUserDictSpy).not.toHaveBeenCalled();
  });

  it("does NOT call loadUserDict for a shared Latin-only alias", async () => {
    const service = new AliasService(makeRepoStub());

    await service.createAlias(1, "Alice", undefined, undefined);

    expect(loadUserDictSpy).not.toHaveBeenCalled();
  });

  it("does NOT call loadUserDict for a private Latin alias", async () => {
    const service = new AliasService(makeRepoStub());

    await service.createAlias(1, "Bob", undefined, "agent_b");

    expect(loadUserDictSpy).not.toHaveBeenCalled();
  });

  it("returns the repo's id even when sync runs", async () => {
    const service = new AliasService(makeRepoStub(999));

    const id = await service.createAlias(7, "管家", undefined, undefined);

    expect(id).toBe(999);
    expect(loadUserDictSpy).toHaveBeenCalledTimes(1);
  });
});
