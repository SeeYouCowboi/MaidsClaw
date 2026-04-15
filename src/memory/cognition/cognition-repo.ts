import { MaidsClawError } from "../../core/errors.js";
import type {
  AssertionBasis,
  AssertionStance,
  CognitionKind,
} from "../../runtime/rp-turn-contract.js";
import type { NodeRef } from "../types.js";
import {
  TERMINAL_STANCES,
  assertLegalStanceTransition,
  assertBasisUpgradeOnly,
} from "./belief-revision.js";
import type { ExistingAssertionState } from "./belief-revision.js";
import type {
  CognitionEventAppendParams,
  CognitionEventRow,
} from "./cognition-event-repo.js";
import type { CognitionCurrentRow } from "./private-cognition-current.js";
import type { CognitionEventRepo } from "../../storage/domain-repos/contracts/cognition-event-repo.js";
import type { CognitionProjectionRepo } from "../../storage/domain-repos/contracts/cognition-projection-repo.js";
import type { SearchProjectionRepo } from "../../storage/domain-repos/contracts/search-projection-repo.js";

type UpsertAssertionParams = {
  agentId: string;
  cognitionKey?: string;
  settlementId: string;
  opIndex: number;
  holderPointerKey: string;
  claim: string;
  entityPointerKeys: string[];
  stance: AssertionStance;
  basis?: AssertionBasis;
  preContestedStance?: AssertionStance;
  provenance?: string;
  requestId?: string;
};

type UpsertEvaluationParams = {
  agentId: string;
  cognitionKey?: string;
  settlementId: string;
  opIndex: number;
  targetEntityId?: number;
  salience?: number;
  dimensions: Array<{ name: string; value: number }>;
  emotionTags?: string[];
  notes?: string;
  requestId?: string;
};

type UpsertCommitmentParams = {
  agentId: string;
  cognitionKey?: string;
  settlementId: string;
  opIndex: number;
  targetEntityId?: number;
  salience?: number;
  mode: "goal" | "intent" | "plan" | "constraint" | "avoidance";
  target: unknown;
  status: "active" | "paused" | "fulfilled" | "abandoned";
  priority?: number;
  horizon?: "immediate" | "near" | "long";
  requestId?: string;
};

type CanonicalAssertionRow = {
  id: number;
  agentId: string;
  sourceEntityId: number;
  targetEntityId: number;
  predicate: string;
  cognitionKey: string | null;
  settlementId: string | null;
  opIndex: number | null;
  provenance: string | null;
  sourceEventRef: string | null;
  stance: AssertionStance;
  basis: AssertionBasis | null;
  preContestedStance: AssertionStance | null;
  createdAt: number;
  updatedAt: number;
};

type CanonicalEvaluationRow = {
  id: number;
  agentId: string;
  cognitionKey: string | null;
  settlementId: string | null;
  opIndex: number | null;
  salience: number | null;
  targetEntityId: number | null;
  dimensions: Array<{ name: string; value: number }>;
  emotionTags: string[];
  notes: string | null;
  status: "active" | "retracted";
  createdAt: number;
  updatedAt: number | null;
};

type CanonicalCommitmentRow = {
  id: number;
  agentId: string;
  cognitionKey: string | null;
  settlementId: string | null;
  opIndex: number | null;
  salience: number | null;
  targetEntityId: number | null;
  mode: "goal" | "intent" | "plan" | "constraint" | "avoidance";
  target: unknown;
  commitmentStatus: "active" | "paused" | "fulfilled" | "abandoned";
  priority: number | null;
  horizon: "immediate" | "near" | "long" | null;
  status: "active" | "retracted";
  createdAt: number;
  updatedAt: number | null;
};

type AssertionProjectionRecord = {
  holderPointerKey?: string;
  claim?: string;
  entityPointerKeys?: string[];
  stance?: AssertionStance;
  basis?: AssertionBasis;
  preContestedStance?: AssertionStance;
  provenance?: string;
};

type CognitionRepositoryDeps = {
  cognitionProjectionRepo: CognitionProjectionRepo;
  cognitionEventRepo: CognitionEventRepo;
  searchProjectionRepo: SearchProjectionRepo;
  entityResolver: (
    pointerKey: string,
    agentId: string,
  ) => Promise<number | null>;
};

export class CognitionRepository {
  private readonly deps: CognitionRepositoryDeps;

  constructor(deps: CognitionRepositoryDeps | unknown) {
    this.deps = isCognitionRepositoryDeps(deps)
      ? deps
      : createUnsupportedDeps();
  }

  getEventRepo(): CognitionEventRepo {
    return this.deps.cognitionEventRepo;
  }

  async upsertAssertion(
    params: UpsertAssertionParams,
  ): Promise<{ id: number }> {
    const holderEntityId = await this.resolveEntityByPointerKey(
      params.holderPointerKey,
      params.agentId,
    );
    if (holderEntityId === null) {
      throw new MaidsClawError({
        code: "COGNITION_UNRESOLVED_REFS",
        message: `Unresolved holder entity ref in explicit assertion: ${params.holderPointerKey}`,
        retriable: true,
        details: {
          unresolvedPointerKeys: [params.holderPointerKey],
          cognitionKey: params.cognitionKey,
          settlementId: params.settlementId,
        },
      });
    }
    const unresolvedPointerKeys: string[] = [];
    for (const key of params.entityPointerKeys) {
      const id = await this.resolveEntityByPointerKey(key, params.agentId);
      if (id === null) unresolvedPointerKeys.push(key);
    }
    if (unresolvedPointerKeys.length > 0) {
      throw new MaidsClawError({
        code: "COGNITION_UNRESOLVED_REFS",
        message: `Unresolved entity refs in explicit assertion: ${unresolvedPointerKeys.join(", ")}`,
        retriable: true,
        details: {
          unresolvedPointerKeys,
          cognitionKey: params.cognitionKey,
          settlementId: params.settlementId,
        },
      });
    }

    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");

    if (params.stance === "contested" && !params.preContestedStance) {
      throw new MaidsClawError({
        code: "COGNITION_MISSING_PRE_CONTESTED_STANCE",
        message: "contested assertion writes must include preContestedStance",
        retriable: false,
        details: { cognitionKey, stance: params.stance },
      });
    }

    const recordJson = JSON.stringify({
      holderPointerKey: params.holderPointerKey,
      claim: params.claim,
      entityPointerKeys: params.entityPointerKeys,
      stance: params.stance,
      basis: params.basis ?? null,
      preContestedStance: params.preContestedStance ?? null,
      provenance: params.provenance ?? null,
    });

    if (cognitionKey) {
      const existing = await this.getExistingAssertionState(
        params.agentId,
        cognitionKey,
      );

      if (existing?.stance && TERMINAL_STANCES.has(existing.stance)) {
        throw new MaidsClawError({
          code: "COGNITION_TERMINAL_KEY_REUSE",
          message:
            "terminal assertion keys cannot be reused; create a new cognition key",
          retriable: false,
          details: {
            cognitionKey,
            currentStance: existing.stance,
            targetStance: params.stance,
          },
        });
      }

      if (existing?.stance && params.stance !== existing.stance) {
        assertLegalStanceTransition(existing, params.stance, cognitionKey);
      }

      if (existing) {
        assertBasisUpgradeOnly(existing.basis, params.basis, cognitionKey);
      }

      const projectionId = await this.appendAndProject({
        agentId: params.agentId,
        cognitionKey,
        kind: "assertion",
        op: "upsert",
        recordJson,
        settlementId: params.settlementId,
        committedTime: now,
        requestId: params.requestId,
      });

      await this.syncCognitionSearchDoc({
        overlayId: projectionId,
        agentId: params.agentId,
        kind: "assertion",
        content: `[${params.holderPointerKey}] ${params.claim}`,
        stance: params.stance,
        basis: params.basis ?? null,
        sourceRefKind: "assertion",
        now,
      });

      return { id: projectionId };
    }

    const cognitionKeyForProjection = `__anon_assertion__${params.settlementId}:${params.opIndex}:${now}`;
    const projectionId = await this.appendAndProject({
      agentId: params.agentId,
      cognitionKey: cognitionKeyForProjection,
      kind: "assertion",
      op: "upsert",
      recordJson,
      settlementId: params.settlementId,
      committedTime: now,
      requestId: params.requestId,
    });

    await this.syncCognitionSearchDoc({
      overlayId: projectionId,
      agentId: params.agentId,
      kind: "assertion",
      content: `[${params.holderPointerKey}] ${params.claim}`,
      stance: params.stance,
      basis: params.basis ?? null,
      sourceRefKind: "assertion",
      now,
    });

    return { id: projectionId };
  }

  async upsertEvaluation(
    params: UpsertEvaluationParams,
  ): Promise<{ id: number }> {
    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");
    const eventRecordPayload = {
      dimensions: params.dimensions,
      emotionTags: params.emotionTags ?? [],
      notes: params.notes ?? null,
      salience: params.salience ?? null,
      targetEntityId: params.targetEntityId ?? null,
      settlementId: params.settlementId,
      opIndex: params.opIndex,
    };

    if (cognitionKey) {
      const existing = await this.deps.cognitionProjectionRepo.getCurrent(
        params.agentId,
        cognitionKey,
      );
      if (existing?.kind === "evaluation") {
        const existingRecord = safeParseJson(existing.record_json);
        const createdAt =
          typeof existingRecord.createdAt === "number"
            ? existingRecord.createdAt
            : now;
        const eventRecordJson = JSON.stringify({
          ...eventRecordPayload,
          createdAt,
        });
        const projectionId = await this.appendAndProject({
          agentId: params.agentId,
          cognitionKey,
          kind: "evaluation",
          op: "upsert",
          recordJson: eventRecordJson,
          settlementId: params.settlementId,
          committedTime: now,
          requestId: params.requestId,
        });
        const summaryText = `evaluation: ${params.notes ?? ""}`;

        await this.syncCognitionSearchDoc({
          overlayId: projectionId,
          agentId: params.agentId,
          kind: "evaluation",
          content: summaryText,
          stance: null,
          basis: null,
          sourceRefKind: "evaluation",
          now,
        });
        return { id: projectionId };
      }
    }

    const effectiveKey =
      cognitionKey ??
      `__anon_evaluation__${params.settlementId}:${params.opIndex}:${now}`;
    const eventRecordJson = JSON.stringify({
      ...eventRecordPayload,
      createdAt: now,
    });
    const projectionId = await this.appendAndProject({
      agentId: params.agentId,
      cognitionKey: effectiveKey,
      kind: "evaluation",
      op: "upsert",
      recordJson: eventRecordJson,
      settlementId: params.settlementId,
      committedTime: now,
      requestId: params.requestId,
    });
    const summaryText = `evaluation: ${params.notes ?? ""}`;

    await this.syncCognitionSearchDoc({
      overlayId: projectionId,
      agentId: params.agentId,
      kind: "evaluation",
      content: summaryText,
      stance: null,
      basis: null,
      sourceRefKind: "evaluation",
      now,
    });
    return { id: projectionId };
  }

  async upsertCommitment(
    params: UpsertCommitmentParams,
  ): Promise<{ id: number }> {
    const now = Date.now();
    const cognitionKey = params.cognitionKey?.normalize("NFC");
    const eventRecordPayload = {
      mode: params.mode,
      target: params.target,
      status: params.status,
      priority: params.priority ?? null,
      horizon: params.horizon ?? null,
      salience: params.salience ?? null,
      targetEntityId: params.targetEntityId ?? null,
      settlementId: params.settlementId,
      opIndex: params.opIndex,
    };

    if (cognitionKey) {
      const existing = await this.deps.cognitionProjectionRepo.getCurrent(
        params.agentId,
        cognitionKey,
      );
      if (existing?.kind === "commitment") {
        const existingRecord = safeParseJson(existing.record_json);
        const createdAt =
          typeof existingRecord.createdAt === "number"
            ? existingRecord.createdAt
            : now;
        const eventRecordJson = JSON.stringify({
          ...eventRecordPayload,
          createdAt,
        });
        const projectionId = await this.appendAndProject({
          agentId: params.agentId,
          cognitionKey,
          kind: "commitment",
          op: "upsert",
          recordJson: eventRecordJson,
          settlementId: params.settlementId,
          committedTime: now,
          requestId: params.requestId,
        });
        const summaryText = `${params.mode}: ${JSON.stringify(params.target)}`;

        await this.syncCognitionSearchDoc({
          overlayId: projectionId,
          agentId: params.agentId,
          kind: "commitment",
          content: summaryText,
          stance: null,
          basis: null,
          sourceRefKind: "commitment",
          now,
        });
        return { id: projectionId };
      }
    }

    const effectiveKey =
      cognitionKey ??
      `__anon_commitment__${params.settlementId}:${params.opIndex}:${now}`;
    const eventRecordJson = JSON.stringify({
      ...eventRecordPayload,
      createdAt: now,
    });
    const projectionId = await this.appendAndProject({
      agentId: params.agentId,
      cognitionKey: effectiveKey,
      kind: "commitment",
      op: "upsert",
      recordJson: eventRecordJson,
      settlementId: params.settlementId,
      committedTime: now,
      requestId: params.requestId,
    });
    const summaryText = `${params.mode}: ${JSON.stringify(params.target)}`;

    await this.syncCognitionSearchDoc({
      overlayId: projectionId,
      agentId: params.agentId,
      kind: "commitment",
      content: summaryText,
      stance: null,
      basis: null,
      sourceRefKind: "commitment",
      now,
    });
    return { id: projectionId };
  }

  async retractCognition(
    agentId: string,
    cognitionKey: string,
    kind?: "assertion" | "evaluation" | "commitment",
    settlementId?: string,
    requestId?: string,
  ): Promise<void> {
    const normalizedKey = cognitionKey.normalize("NFC");
    const now = Date.now();
    const effectiveSettlementId = settlementId ?? "__retract__";

    if (kind === "assertion") {
      await this.appendAndProject({
        agentId,
        cognitionKey: normalizedKey,
        kind: "assertion",
        op: "retract",
        recordJson: null,
        settlementId: effectiveSettlementId,
        committedTime: now,
        requestId,
      });
      await this.updateCognitionSearchDocStance(
        agentId,
        "assertion",
        normalizedKey,
        "rejected",
        now,
      );
      return;
    }

    if (kind === "evaluation" || kind === "commitment") {
      await this.appendAndProject({
        agentId,
        cognitionKey: normalizedKey,
        kind,
        op: "retract",
        recordJson: null,
        settlementId: effectiveSettlementId,
        committedTime: now,
        requestId,
      });
      await this.updateCognitionSearchDocStance(
        agentId,
        kind,
        normalizedKey,
        "abandoned",
        now,
      );
      return;
    }

    await this.appendAndProject({
      agentId,
      cognitionKey: normalizedKey,
      kind: "assertion",
      op: "retract",
      recordJson: null,
      settlementId: effectiveSettlementId,
      committedTime: now,
      requestId,
    });
    await this.updateCognitionSearchDocStance(
      agentId,
      "assertion",
      normalizedKey,
      "rejected",
      now,
    );
    await this.updateCognitionSearchDocStance(
      agentId,
      "evaluation",
      normalizedKey,
      "abandoned",
      now,
    );
    await this.updateCognitionSearchDocStance(
      agentId,
      "commitment",
      normalizedKey,
      "abandoned",
      now,
    );
  }

  async getAssertions(
    agentId: string,
    options?: {
      activeOnly?: boolean;
      stance?: AssertionStance;
      basis?: AssertionBasis;
    },
  ): Promise<CanonicalAssertionRow[]> {
    const keyedRows = (
      await this.deps.cognitionProjectionRepo.getAllCurrent(agentId)
    )
      .filter((row) => row.kind === "assertion")
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 500);

    let mapped = (
      await Promise.all(
        keyedRows.map((row) => this.toCanonicalAssertionFromProjection(row)),
      )
    ).filter((row): row is CanonicalAssertionRow => row !== null);

    if (options?.activeOnly) {
      mapped = mapped.filter(
        (row) => row.stance !== "rejected" && row.stance !== "abandoned",
      );
    }
    if (options?.stance) {
      mapped = mapped.filter((row) => row.stance === options.stance);
    }
    if (options?.basis) {
      mapped = mapped.filter((row) => row.basis === options.basis);
    }
    return mapped;
  }

  async getEvaluations(
    agentId: string,
    options?: { activeOnly?: boolean },
  ): Promise<CanonicalEvaluationRow[]> {
    const rows = (
      await this.deps.cognitionProjectionRepo.getAllCurrent(agentId)
    )
      .filter((row) => row.kind === "evaluation")
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 500);

    const mapped = rows.map((row) => this.toCanonicalEvaluation(row));
    if (!options?.activeOnly) {
      return mapped;
    }
    return mapped.filter((row) => row.status === "active");
  }

  async getCommitments(
    agentId: string,
    options?: { activeOnly?: boolean; mode?: string },
  ): Promise<CanonicalCommitmentRow[]> {
    const rows = (
      await this.deps.cognitionProjectionRepo.getAllCurrent(agentId)
    )
      .filter((row) => row.kind === "commitment")
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 500);

    let mapped = rows.map((row) => this.toCanonicalCommitment(row));
    if (options?.activeOnly) {
      mapped = mapped.filter((row) => row.status === "active");
    }
    if (options?.mode) {
      mapped = mapped.filter((row) => row.mode === options.mode);
    }
    return mapped;
  }

  async getAssertionByKey(
    agentId: string,
    cognitionKey: string,
  ): Promise<CanonicalAssertionRow | null> {
    const keyed = await this.deps.cognitionProjectionRepo.getCurrent(
      agentId,
      cognitionKey.normalize("NFC"),
    );
    if (!keyed || keyed.kind !== "assertion") return null;
    return this.toCanonicalAssertionFromProjection(keyed);
  }

  async getEvaluationByKey(
    agentId: string,
    cognitionKey: string,
  ): Promise<CanonicalEvaluationRow | null> {
    const row = await this.deps.cognitionProjectionRepo.getCurrent(
      agentId,
      cognitionKey.normalize("NFC"),
    );
    if (!row || row.kind !== "evaluation") return null;
    return this.toCanonicalEvaluation(row);
  }

  async getCommitmentByKey(
    agentId: string,
    cognitionKey: string,
  ): Promise<CanonicalCommitmentRow | null> {
    const row = await this.deps.cognitionProjectionRepo.getCurrent(
      agentId,
      cognitionKey.normalize("NFC"),
    );
    if (!row || row.kind !== "commitment") return null;
    return this.toCanonicalCommitment(row);
  }

  private async getExistingAssertionState(
    agentId: string,
    cognitionKey: string,
  ): Promise<ExistingAssertionState | null> {
    const current = await this.deps.cognitionProjectionRepo.getCurrent(
      agentId,
      cognitionKey,
    );
    if (!current || current.kind !== "assertion") {
      return null;
    }
    return {
      id: current.id,
      stance: (current.stance as AssertionStance | null) ?? null,
      basis: (current.basis as AssertionBasis | null) ?? null,
      preContestedStance:
        (current.pre_contested_stance as AssertionStance | null) ?? null,
    };
  }

  private async resolveEntityByPointerKey(
    pointerKey: string,
    agentId: string,
  ): Promise<number | null> {
    return this.deps.entityResolver(pointerKey.normalize("NFC"), agentId);
  }

  private async appendAndProject(
    params: CognitionEventAppendParams,
  ): Promise<number> {
    const event = await this.appendEvent(params);
    if (event === null) {
      // Conflict hit — event already exists. Get existing projection id.
      const projection = await this.deps.cognitionProjectionRepo.getCurrent(
        params.agentId,
        params.cognitionKey,
      );
      if (!projection) {
        throw new Error(
          `Failed to sync projection id for ${params.agentId}/${params.cognitionKey}`,
        );
      }
      return projection.id;
    }
    await this.deps.cognitionProjectionRepo.upsertFromEvent(event);
    const projection = await this.deps.cognitionProjectionRepo.getCurrent(
      params.agentId,
      params.cognitionKey,
    );
    if (!projection) {
      throw new Error(
        `Failed to sync projection id for ${params.agentId}/${params.cognitionKey}`,
      );
    }
    return projection.id;
  }

  private async appendEvent(
    params: CognitionEventAppendParams,
  ): Promise<CognitionEventRow | null> {
    const eventId = await this.deps.cognitionEventRepo.append(params);
    if (eventId === null) return null;
    return {
      id: eventId,
      agent_id: params.agentId,
      cognition_key: params.cognitionKey,
      kind: params.kind,
      op: params.op,
      record_json: params.recordJson,
      settlement_id: params.settlementId,
      committed_time: params.committedTime,
      request_id: params.requestId ?? null,
      created_at: params.committedTime,
    };
  }

  private async toCanonicalAssertionFromProjection(
    row: CognitionCurrentRow,
  ): Promise<CanonicalAssertionRow | null> {
    if (!row.stance) {
      return null;
    }
    const parsed = safeParseJson(row.record_json) as AssertionProjectionRecord;
    const holderEntityId =
      typeof parsed.holderPointerKey === "string"
        ? await this.resolveEntityByPointerKey(
            parsed.holderPointerKey,
            row.agent_id,
          )
        : null;
    // Use first entityPointerKey as targetEntityId for backward compat with CanonicalAssertionRow shape
    const firstEntityKey =
      Array.isArray(parsed.entityPointerKeys) &&
      parsed.entityPointerKeys.length > 0
        ? parsed.entityPointerKeys[0]
        : undefined;
    const targetEntityId =
      typeof firstEntityKey === "string"
        ? await this.resolveEntityByPointerKey(firstEntityKey, row.agent_id)
        : null;
    if (
      holderEntityId == null ||
      targetEntityId == null ||
      typeof parsed.claim !== "string"
    ) {
      return null;
    }

    const projectionRecord = safeParseJson(row.record_json);
    return {
      id: row.id,
      agentId: row.agent_id,
      sourceEntityId: holderEntityId,
      targetEntityId,
      predicate: parsed.claim,
      cognitionKey: row.cognition_key,
      settlementId:
        typeof projectionRecord.settlementId === "string"
          ? projectionRecord.settlementId
          : null,
      opIndex:
        typeof projectionRecord.opIndex === "number"
          ? projectionRecord.opIndex
          : null,
      provenance:
        typeof parsed.provenance === "string" ? parsed.provenance : null,
      sourceEventRef: null,
      stance: row.stance as AssertionStance,
      basis: (row.basis as AssertionBasis | null) ?? null,
      preContestedStance:
        (row.pre_contested_stance as AssertionStance | null) ?? null,
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    };
  }

  private toCanonicalEvaluation(
    row: CognitionCurrentRow,
  ): CanonicalEvaluationRow {
    const parsed = safeParseJson(row.record_json);
    return {
      id: row.id,
      agentId: row.agent_id,
      cognitionKey: row.cognition_key,
      settlementId:
        typeof parsed.settlementId === "string" ? parsed.settlementId : null,
      opIndex: typeof parsed.opIndex === "number" ? parsed.opIndex : null,
      salience: typeof parsed.salience === "number" ? parsed.salience : null,
      targetEntityId:
        typeof parsed.targetEntityId === "number"
          ? parsed.targetEntityId
          : null,
      dimensions: Array.isArray(parsed.dimensions)
        ? (parsed.dimensions as Array<{ name: string; value: number }>)
        : [],
      emotionTags: Array.isArray(parsed.emotionTags)
        ? (parsed.emotionTags as string[])
        : [],
      notes: typeof parsed.notes === "string" ? parsed.notes : null,
      status: row.status as "active" | "retracted",
      createdAt:
        typeof parsed.createdAt === "number"
          ? parsed.createdAt
          : row.updated_at,
      updatedAt: row.updated_at,
    };
  }

  private toCanonicalCommitment(
    row: CognitionCurrentRow,
  ): CanonicalCommitmentRow {
    const parsed = safeParseJson(row.record_json);
    return {
      id: row.id,
      agentId: row.agent_id,
      cognitionKey: row.cognition_key,
      settlementId:
        typeof parsed.settlementId === "string" ? parsed.settlementId : null,
      opIndex: typeof parsed.opIndex === "number" ? parsed.opIndex : null,
      salience: typeof parsed.salience === "number" ? parsed.salience : null,
      targetEntityId:
        typeof parsed.targetEntityId === "number"
          ? parsed.targetEntityId
          : null,
      mode: asCommitmentMode(parsed.mode),
      target: parsed.target,
      commitmentStatus: asCommitmentStatus(parsed.status),
      priority: typeof parsed.priority === "number" ? parsed.priority : null,
      horizon: asCommitmentHorizon(parsed.horizon),
      status: row.status as "active" | "retracted",
      createdAt:
        typeof parsed.createdAt === "number"
          ? parsed.createdAt
          : row.updated_at,
      updatedAt: row.updated_at,
    };
  }

  private async updateCognitionSearchDocStance(
    agentId: string,
    refKind: "assertion" | "evaluation" | "commitment",
    cognitionKey: string,
    newStance: AssertionStance,
    now: number,
  ): Promise<void> {
    const rows = (
      await this.deps.cognitionProjectionRepo.getAllCurrent(agentId)
    ).filter(
      (row) => row.cognition_key === cognitionKey && row.kind === refKind,
    );

    for (const row of rows) {
      await this.deps.searchProjectionRepo.updateCognitionSearchDocStanceBySourceRef(
        `${refKind}:${row.id}` as NodeRef,
        agentId,
        newStance,
        now,
      );
    }
  }

  private async syncCognitionSearchDoc(params: {
    overlayId: number;
    agentId: string;
    kind: CognitionKind;
    content: string;
    stance: AssertionStance | null;
    basis: AssertionBasis | null;
    sourceRefKind: "assertion" | "evaluation" | "commitment";
    now: number;
  }): Promise<void> {
    const sourceRef = `${params.sourceRefKind}:${params.overlayId}` as NodeRef;

    await this.deps.searchProjectionRepo.upsertCognitionDoc({
      sourceRef,
      agentId: params.agentId,
      kind: params.kind,
      basis: params.basis ?? null,
      stance: params.stance ?? null,
      content: params.content,
      updatedAt: params.now,
      createdAt: params.now,
    });
  }
}

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asCommitmentMode(
  value: unknown,
): "goal" | "intent" | "plan" | "constraint" | "avoidance" {
  if (
    value === "goal" ||
    value === "intent" ||
    value === "plan" ||
    value === "constraint" ||
    value === "avoidance"
  ) {
    return value;
  }
  return "goal";
}

function asCommitmentStatus(
  value: unknown,
): "active" | "paused" | "fulfilled" | "abandoned" {
  if (
    value === "active" ||
    value === "paused" ||
    value === "fulfilled" ||
    value === "abandoned"
  ) {
    return value;
  }
  return "active";
}

function asCommitmentHorizon(
  value: unknown,
): "immediate" | "near" | "long" | null {
  if (value === "immediate" || value === "near" || value === "long") {
    return value;
  }
  return null;
}

function isCognitionRepositoryDeps(
  value: unknown,
): value is CognitionRepositoryDeps {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CognitionRepositoryDeps>;
  return (
    typeof candidate.cognitionProjectionRepo === "object" &&
    candidate.cognitionProjectionRepo !== null &&
    typeof candidate.cognitionEventRepo === "object" &&
    candidate.cognitionEventRepo !== null &&
    typeof candidate.searchProjectionRepo === "object" &&
    candidate.searchProjectionRepo !== null &&
    typeof candidate.entityResolver === "function"
  );
}

function createUnsupportedDeps(): CognitionRepositoryDeps {
  const unsupported = (): never => {
    throw new Error("CognitionRepository requires PG repo dependencies");
  };

  return {
    cognitionProjectionRepo: {
      upsertFromEvent: async () => unsupported(),
      rebuild: async () => unsupported(),
      getCurrent: async () => unsupported(),
      getAllCurrent: async () => unsupported(),
      updateConflictFactors: async () => unsupported(),
      patchRecordJsonSourceEventRef: async () => unsupported(),
      resolveEntityByPointerKey: async () => unsupported(),
    },
    cognitionEventRepo: {
      append: async () => unsupported(),
      readByAgent: async () => unsupported(),
      readByCognitionKey: async () => unsupported(),
      replay: async () => unsupported(),
    },
    searchProjectionRepo: {
      syncSearchDoc: async () => unsupported(),
      removeSearchDoc: async () => unsupported(),
      rebuildForScope: async () => unsupported(),
      upsertCognitionDoc: async () => unsupported(),
      upsertEpisodeDoc: async () => unsupported(),
      updateCognitionSearchDocStanceBySourceRef: async () => unsupported(),
    },
    entityResolver: async () => unsupported(),
  };
}

export type {
  CanonicalAssertionRow,
  CanonicalCommitmentRow,
  CanonicalEvaluationRow,
  CognitionRepositoryDeps,
  UpsertAssertionParams,
  UpsertCommitmentParams,
  UpsertEvaluationParams,
};
