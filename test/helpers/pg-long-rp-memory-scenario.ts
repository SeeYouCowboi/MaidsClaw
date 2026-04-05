import type postgres from "postgres";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import type { NodeRef, ViewerContext } from "../../src/memory/types.js";
import { PgCognitionEventRepo } from "../../src/storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgEpisodeRepo } from "../../src/storage/domain-repos/pg/episode-repo.js";
import { PgGraphMutableStoreRepo } from "../../src/storage/domain-repos/pg/graph-mutable-store-repo.js";
import { PgInteractionRepo } from "../../src/storage/domain-repos/pg/interaction-repo.js";
import { PgRecentCognitionSlotRepo } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { seedStandardPgEntities } from "./pg-app-test-utils.js";

const ref = (value: string): NodeRef => value as NodeRef;

const BASE_TIME = 1_730_000_000_000;

export type LongRpRetrievalScenario = {
  viewer: ViewerContext;
  typedQuery: string;
  episodeQuery: string;
  narrativeQuery: string;
  cognitionQuery: string;
  exploreQuery: string;
  expectedNarrativeFragments: string[];
  expectedCognitionFragments: string[];
  expectedEpisodeFragments: string[];
  stats: {
    conversationMessages: number;
    narrativeDocs: number;
    cognitionEntries: number;
    episodeRows: number;
  };
};

type NarrativeDocParams = {
  sessionId: string;
  summary: string;
  content: string;
  locationEntityId: number;
  timestamp: number;
  scope: "area" | "world";
  primaryActorEntityId?: number;
  participants?: string[];
};

async function createNarrativeDoc(
  graphStoreRepo: PgGraphMutableStoreRepo,
  searchProjectionRepo: PgSearchProjectionRepo,
  params: NarrativeDocParams,
): Promise<number> {
  const eventId = await graphStoreRepo.createProjectedEvent({
    sessionId: params.sessionId,
    summary: params.summary,
    timestamp: params.timestamp,
    participants: JSON.stringify(params.participants ?? []),
    locationEntityId: params.locationEntityId,
    eventCategory: "observation",
    primaryActorEntityId: params.primaryActorEntityId,
    origin: "runtime_projection",
    visibilityScope: params.scope === "area" ? "area_visible" : "world_public",
  });

  await searchProjectionRepo.syncSearchDoc(
    params.scope,
    ref(`event:${eventId}`),
    params.content,
    undefined,
    params.scope === "area" ? params.locationEntityId : undefined,
  );

  return eventId;
}

function makeConversationHistory(): string[] {
  const setup = [
    "The silver key went missing from the greenhouse ledger drawer.",
    "I noticed butler_oswin waiting beside the greenhouse shelf after dusk.",
    "Remember that Mira moved the silver key when the corridor finally emptied.",
    "I will keep the ledger cabinet under watch until the household sleeps.",
    "The archive lamps burned low while the greenhouse door stayed unlatched.",
    "Butler Oswin asked twice whether the silver key had already been catalogued.",
    "Mira said the ledger shelf has a false back behind the dust jackets.",
    "If this turns into a trap, we keep the silver key away from Oswin.",
  ];

  const routine = Array.from({ length: 20 }, (_, index) =>
    `Routine manor exchange ${index + 1}: tea routes, guest lists, lamps, and corridor patrol timing were adjusted without incident.`,
  );

  return [...setup, ...routine];
}

async function seedConversationHistory(
  interactionRepo: PgInteractionRepo,
  sessionId: string,
): Promise<number> {
  const messages = makeConversationHistory();

  for (const [index, content] of messages.entries()) {
    const actorType = index % 2 === 0 ? "user" : "rp_agent";
    await interactionRepo.commit({
      sessionId,
      recordId: `long-rp-msg-${index + 1}`,
      recordIndex: index + 1,
      actorType,
      recordType: "message",
      payload: {
        role: actorType === "user" ? "user" : "assistant",
        content,
      },
      committedAt: BASE_TIME + index * 1_000,
    });
  }

  return messages.length;
}

async function seedEpisodes(
  episodeRepo: PgEpisodeRepo,
  params: {
    agentId: string;
    sessionId: string;
    greenhouseId: number;
    archiveId: number;
    courtyardId: number;
  },
): Promise<{
  rowCount: number;
  expectedEpisodeFragments: string[];
}> {
  let rowCount = 0;

  for (let index = 0; index < 12; index += 1) {
    const inArchive = index % 2 === 0;
    await episodeRepo.append({
      agentId: params.agentId,
      sessionId: params.sessionId,
      settlementId: `episode-routine-${index}`,
      category: inArchive ? "observation" : "speech",
      summary: inArchive
        ? `Routine archive scene ${index}: lamp oil was counted and drawer labels were corrected.`
        : `Routine courtyard scene ${index}: guest routes and tea deliveries were revised.`,
      privateNotes: `background beat ${index}`,
      locationEntityId: inArchive ? params.archiveId : params.courtyardId,
      locationText: inArchive ? "archive" : "courtyard",
      committedTime: BASE_TIME + 100_000 + index * 1_000,
      validTime: BASE_TIME + 100_000 + index * 1_000,
      sourceLocalRef: `routine-episode-${index}`,
    });
    rowCount += 1;
  }

  const expectedEpisodeFragments = [
    "Earlier greenhouse scene: Mira hid the silver key beneath the false ledger shelf.",
    "Earlier greenhouse scene: butler_oswin pressed twice for the silver key and watched the ledger drawer.",
  ];

  await episodeRepo.append({
    agentId: params.agentId,
    sessionId: params.sessionId,
    settlementId: "episode-target-1",
    category: "observation",
    summary: expectedEpisodeFragments[0],
    privateNotes:
      "Mira used the false ledger shelf and marked the edge with a scratch only she would notice.",
    locationEntityId: params.greenhouseId,
    locationText: "greenhouse",
    committedTime: BASE_TIME + 500_000,
    validTime: BASE_TIME + 500_000,
    sourceLocalRef: "target-episode-1",
  });
  rowCount += 1;

  await episodeRepo.append({
    agentId: params.agentId,
    sessionId: params.sessionId,
    settlementId: "episode-target-2",
    category: "speech",
    summary: expectedEpisodeFragments[1],
    privateNotes:
      "He kept glancing from the key to the ledger shelf as if confirming the hiding place.",
    locationEntityId: params.greenhouseId,
    locationText: "greenhouse",
    committedTime: BASE_TIME + 501_000,
    validTime: BASE_TIME + 501_000,
    sourceLocalRef: "target-episode-2",
  });
  rowCount += 1;

  return {
    rowCount,
    expectedEpisodeFragments,
  };
}

async function seedNarrativeDocs(
  graphStoreRepo: PgGraphMutableStoreRepo,
  searchProjectionRepo: PgSearchProjectionRepo,
  params: {
    sessionId: string;
    greenhouseId: number;
    archiveId: number;
    courtyardId: number;
    miraId: number;
    butlerId: number;
  },
): Promise<{
  docCount: number;
  expectedNarrativeFragments: string[];
}> {
  let docCount = 0;

  for (let index = 0; index < 24; index += 1) {
    const inGreenhouse = index % 4 === 0;
    const inArchive = index % 2 === 0;
    await createNarrativeDoc(graphStoreRepo, searchProjectionRepo, {
      sessionId: params.sessionId,
      summary: `Routine manor note ${index}`,
      content: inGreenhouse
        ? `routine greenhouse maintenance ${index}: clipped ivy, counted lantern oil, and reorganized seed trays.`
        : inArchive
          ? `routine archive maintenance ${index}: dusted drawers, updated catalog cards, and sorted wax seals.`
          : `routine courtyard maintenance ${index}: guest routes, bell timing, and tea trays were adjusted.`,
      locationEntityId: inGreenhouse
        ? params.greenhouseId
        : inArchive
          ? params.archiveId
          : params.courtyardId,
      timestamp: BASE_TIME + 200_000 + index * 500,
      scope: index % 3 === 0 ? "area" : "world",
      primaryActorEntityId: inGreenhouse ? params.miraId : undefined,
    });
    docCount += 1;
  }

  const expectedNarrativeFragments = [
    "silver key beneath the greenhouse false ledger shelf after butler_oswin asked for it twice",
    "butler_oswin copied the greenhouse vault schedule from the ledger and slipped the page into his sleeve",
    "Mira marked the false ledger shelf with blue wax so only she would find the silver key again",
  ];

  await createNarrativeDoc(graphStoreRepo, searchProjectionRepo, {
    sessionId: params.sessionId,
    summary: "Silver key hidden in greenhouse shelf",
    content: expectedNarrativeFragments[0],
    locationEntityId: params.greenhouseId,
    timestamp: BASE_TIME + 700_000,
    scope: "area",
    primaryActorEntityId: params.miraId,
    participants: [`entity:${params.miraId}`, `entity:${params.butlerId}`],
  });
  docCount += 1;

  await createNarrativeDoc(graphStoreRepo, searchProjectionRepo, {
    sessionId: params.sessionId,
    summary: "Butler copied the greenhouse schedule",
    content: expectedNarrativeFragments[1],
    locationEntityId: params.greenhouseId,
    timestamp: BASE_TIME + 701_000,
    scope: "world",
    primaryActorEntityId: params.butlerId,
    participants: [`entity:${params.butlerId}`],
  });
  docCount += 1;

  await createNarrativeDoc(graphStoreRepo, searchProjectionRepo, {
    sessionId: params.sessionId,
    summary: "Mira marked the shelf",
    content: expectedNarrativeFragments[2],
    locationEntityId: params.greenhouseId,
    timestamp: BASE_TIME + 702_000,
    scope: "area",
    primaryActorEntityId: params.miraId,
    participants: [`entity:${params.miraId}`],
  });
  docCount += 1;

  return {
    docCount,
    expectedNarrativeFragments,
  };
}

async function seedCognitionHistory(
  sql: postgres.Sql,
  params: {
    agentId: string;
    silverKeyPointer: string;
    butlerPointer: string;
  },
): Promise<{
  entryCount: number;
  expectedCognitionFragments: string[];
}> {
  const searchProjectionRepo = new PgSearchProjectionRepo(sql);
  const cognitionProjectionRepo = new PgCognitionProjectionRepo(sql);
  const cognitionRepo = new CognitionRepository({
    cognitionProjectionRepo,
    cognitionEventRepo: new PgCognitionEventRepo(sql),
    searchProjectionRepo,
    entityResolver: (pointerKey: string, agentId: string) =>
      cognitionProjectionRepo.resolveEntityByPointerKey(pointerKey, agentId),
  });

  let entryCount = 0;

  for (let index = 0; index < 8; index += 1) {
    await cognitionRepo.upsertEvaluation({
      agentId: params.agentId,
      cognitionKey: `routine-evaluation-${index}`,
      settlementId: `routine-eval-settlement-${index}`,
      opIndex: 0,
      salience: 0.2,
      targetEntityId: undefined,
      dimensions: [{ name: "order", value: 0.4 + index * 0.01 }],
      emotionTags: ["calm"],
      notes: `Routine assessment ${index}: tea routes, lamp oil, and guest pacing remain orderly.`,
    });
    entryCount += 1;
  }

  for (let index = 0; index < 6; index += 1) {
    await cognitionRepo.upsertCommitment({
      agentId: params.agentId,
      cognitionKey: `routine-commitment-${index}`,
      settlementId: `routine-commit-settlement-${index}`,
      opIndex: 0,
      mode: "plan",
      target: {
        task: `prepare corridor checkpoint ${index}`,
      },
      status: "active",
      priority: 5 + index,
      horizon: "near",
      salience: 0.3,
      targetEntityId: undefined,
    });
    entryCount += 1;
  }

  const expectedCognitionFragments = [
    `must_not_be_given_to: ${params.silverKeyPointer} → ${params.butlerPointer}`,
    "evaluation: butler_oswin becomes evasive whenever the greenhouse ledger or silver_key is mentioned",
    "keep silver_key hidden beneath the greenhouse false ledger shelf until the ledger code is verified",
  ];

  await cognitionRepo.upsertAssertion({
    agentId: params.agentId,
    cognitionKey: "silver-key-risk",
    settlementId: "target-assert-settlement",
    opIndex: 0,
    sourcePointerKey: params.silverKeyPointer,
    predicate: "must_not_be_given_to",
    targetPointerKey: params.butlerPointer,
    stance: "accepted",
    basis: "first_hand",
  });
  entryCount += 1;

  await cognitionRepo.upsertEvaluation({
    agentId: params.agentId,
    cognitionKey: "ledger-warning",
    settlementId: "target-eval-settlement",
    opIndex: 0,
    salience: 0.95,
    targetEntityId: undefined,
    dimensions: [{ name: "risk", value: 0.92 }],
    emotionTags: ["alert"],
    notes:
      "butler_oswin becomes evasive whenever the greenhouse ledger or silver_key is mentioned",
  });
  entryCount += 1;

  await cognitionRepo.upsertCommitment({
    agentId: params.agentId,
    cognitionKey: "protect-silver-key",
    settlementId: "target-commitment-settlement",
    opIndex: 0,
    mode: "constraint",
    target: {
      rule:
        "keep silver_key hidden beneath the greenhouse false ledger shelf until the ledger code is verified",
    },
    status: "active",
    priority: 1,
    horizon: "immediate",
    salience: 0.98,
    targetEntityId: undefined,
  });
  entryCount += 1;

  return {
    entryCount,
    expectedCognitionFragments,
  };
}

async function seedRecentCognitionSlot(
  recentSlotRepo: PgRecentCognitionSlotRepo,
  sessionId: string,
  agentId: string,
): Promise<void> {
  await recentSlotRepo.upsertRecentCognitionSlot(
    sessionId,
    agentId,
    "recent-cognition-slot-1",
    JSON.stringify([
      {
        settlementId: "recent-cognition-slot-1",
        committedAt: BASE_TIME + 800_000,
        kind: "evaluation",
        key: "patrol-rhythm",
        summary: "evaluation: the east stair patrol is predictable tonight",
      },
      {
        settlementId: "recent-cognition-slot-1",
        committedAt: BASE_TIME + 801_000,
        kind: "commitment",
        key: "supper-bells",
        summary: 'plan: {"task":"rotate the supper bells after the second serving"}',
      },
      {
        settlementId: "recent-cognition-slot-1",
        committedAt: BASE_TIME + 802_000,
        kind: "assertion",
        key: "archive-annex-last-seen",
        summary: "last_seen_near: silver_key → archive_annex",
      },
    ]),
  );
}

export async function seedLongRpRetrievalScenario(
  sql: postgres.Sql,
): Promise<LongRpRetrievalScenario> {
  const graphStoreRepo = new PgGraphMutableStoreRepo(sql);
  const interactionRepo = new PgInteractionRepo(sql);
  const recentSlotRepo = new PgRecentCognitionSlotRepo(sql);
  const episodeRepo = new PgEpisodeRepo(sql);
  const searchProjectionRepo = new PgSearchProjectionRepo(sql);

  await seedStandardPgEntities(sql);
  const greenhouseId = await graphStoreRepo.upsertEntity({
    pointerKey: "greenhouse",
    displayName: "Greenhouse",
    entityType: "location",
    memoryScope: "shared_public",
  });
  const archiveId = await graphStoreRepo.upsertEntity({
    pointerKey: "archive_annex",
    displayName: "Archive Annex",
    entityType: "location",
    memoryScope: "shared_public",
  });
  const courtyardId = await graphStoreRepo.upsertEntity({
    pointerKey: "courtyard",
    displayName: "Courtyard",
    entityType: "location",
    memoryScope: "shared_public",
  });
  const miraId = await graphStoreRepo.upsertEntity({
    pointerKey: "mira",
    displayName: "Mira",
    entityType: "person",
    memoryScope: "shared_public",
  });
  const butlerId = await graphStoreRepo.upsertEntity({
    pointerKey: "butler_oswin",
    displayName: "Butler Oswin",
    entityType: "person",
    memoryScope: "shared_public",
  });
  await graphStoreRepo.upsertEntity({
    pointerKey: "silver_key",
    displayName: "Silver Key",
    entityType: "item",
    memoryScope: "shared_public",
  });
  await graphStoreRepo.upsertEntity({
    pointerKey: "ledger_drawer",
    displayName: "Ledger Drawer",
    entityType: "object",
    memoryScope: "shared_public",
  });

  const agentId = "agent-long-rp";
  const sessionId = "session-long-rp";
  const viewer: ViewerContext = {
    viewer_agent_id: agentId,
    viewer_role: "rp_agent",
    session_id: sessionId,
    current_area_id: greenhouseId,
  };

  const conversationMessages = await seedConversationHistory(
    interactionRepo,
    sessionId,
  );
  await seedRecentCognitionSlot(recentSlotRepo, sessionId, agentId);

  const episodeData = await seedEpisodes(episodeRepo, {
    agentId,
    sessionId,
    greenhouseId,
    archiveId,
    courtyardId,
  });
  const narrativeData = await seedNarrativeDocs(
    graphStoreRepo,
    searchProjectionRepo,
    {
      sessionId,
      greenhouseId,
      archiveId,
      courtyardId,
      miraId,
      butlerId,
    },
  );
  const cognitionData = await seedCognitionHistory(sql, {
    agentId,
    silverKeyPointer: "silver_key",
    butlerPointer: "butler_oswin",
  });

  return {
    viewer,
    typedQuery: "greenhouse silver key false ledger shelf butler_oswin",
    episodeQuery: "earlier greenhouse silver key false ledger shelf butler_oswin",
    narrativeQuery: "silver key beneath the greenhouse false ledger shelf",
    cognitionQuery:
      "butler_oswin becomes evasive whenever the greenhouse ledger or silver_key is mentioned",
    exploreQuery: "why was the silver key hidden in the greenhouse false ledger shelf",
    expectedNarrativeFragments: narrativeData.expectedNarrativeFragments,
    expectedCognitionFragments: cognitionData.expectedCognitionFragments,
    expectedEpisodeFragments: episodeData.expectedEpisodeFragments,
    stats: {
      conversationMessages,
      narrativeDocs: narrativeData.docCount,
      cognitionEntries: cognitionData.entryCount,
      episodeRows: episodeData.rowCount,
    },
  };
}
