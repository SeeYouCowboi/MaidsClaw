import type {
  AssertionStance,
  AssertionBasis,
} from "../../src/runtime/rp-turn-contract.js";
import type {
  PrivateEventCategory,
  LogicEdgeType,
  VisibilityScope,
  MemoryScope,
} from "../../src/memory/types.js";

export type { AssertionStance, AssertionBasis };
export type { PrivateEventCategory, LogicEdgeType, VisibilityScope, MemoryScope };

export type EpisodeCategory = Exclude<PrivateEventCategory, "thought">;

// Character in a story
export type StoryCharacter = {
  id: string; // pointer_key e.g. "butler_oswin"
  displayName: string;
  entityType: "person";
  surfaceMotives: string; // narrative description
  hiddenCommitments: CommitmentSpec[];
  initialEvaluations: EvaluationSpec[];
  aliases: string[];
};

// Location in a story
export type StoryLocation = {
  id: string; // pointer_key
  displayName: string;
  entityType: "location";
  parentLocationId?: string; // pointer_key ref
  visibilityScope: VisibilityScope;
};

// Clue/object in a story
export type StoryClue = {
  id: string; // pointer_key
  displayName: string;
  entityType: "item" | "object";
  initialLocationId: string; // pointer_key ref to location
  description: string;
};

// Beat in a story (one narrative unit / one flush unit)
export type StoryBeat = {
  id: string;
  phase: string; // e.g. "A", "B", "C"
  round: number;
  timestamp: number; // game-world time (ms)
  locationId: string; // pointer_key ref
  participantIds: string[]; // pointer_key refs
  dialogueGuidance: string; // what LLM should discuss
  whoIsLying?: { characterId: string; about: string };
  memoryEffects: MemoryEffect;
  publicationDeclarations?: PublicationDeclaration[];
  expectedToolPattern?: ToolCallPattern;
};

// What a beat produces in memory
export type MemoryEffect = {
  newEntities?: EntitySpec[]; // new entities discovered this beat
  newAliases?: AliasSpec[];
  episodes?: EpisodeSpec[];
  assertions?: AssertionSpec[];
  evaluations?: EvaluationSpec[];
  commitments?: CommitmentSpec[];
  logicEdges?: LogicEdgeSpec[];
  retractions?: RetractionSpec[];
};

// Individual memory specs — map to repository API parameters
export type EpisodeSpec = {
  id: string; // local ref for logic edge resolution
  category: EpisodeCategory; // exclude "thought"
  summary: string;
  privateNotes?: string;
  observerIds: string[]; // pointer_key refs (characters who experience this)
  timestamp: number; // game-world time
  locationId: string; // pointer_key ref
};

export type AssertionSpec = {
  cognitionKey: string; // stable key for stance tracking across beats
  /** Who holds this belief — must reference a character pointer_key. */
  holderId: string;
  /** Free-text natural language proposition. */
  claim: string;
  /** Related entity pointer_keys — for retrieval indexing, no grammar role implied. */
  entityIds: string[];
  stance: AssertionStance;
  basis: AssertionBasis;
  preContestedStance?: AssertionStance; // required when stance === "contested"
  confidence?: number;
  conflictFactors?: string[];
  sourceEpisodeId?: string; // local ref to episode this assertion comes from
};

export type EvaluationSpec = {
  subjectId: string; // who holds the evaluation
  objectId: string; // who/what is being evaluated
  dimensions: { name: string; value: number }[]; // e.g. [{name: "trustworthiness", value: 0.7}]
  sourceEpisodeId?: string;
};

export type CommitmentSpec = {
  cognitionKey: string; // stable key
  subjectId: string; // who holds this commitment
  mode: "intent" | "goal" | "constraint" | "plan";
  content: string;
  isPrivate: boolean; // true = hidden motive not visible to others
  sourceEpisodeId?: string;
};

export type LogicEdgeSpec = {
  fromEpisodeId: string; // local ref — must be an EpisodeSpec.id from same story
  toEpisodeId: string; // local ref
  edgeType: LogicEdgeType;
  weight?: number;
};

export type RetractionSpec = {
  cognitionKey: string; // key of assertion/commitment to retract
  kind: "assertion" | "commitment";
};

export type EntitySpec = {
  id: string; // pointer_key
  displayName: string;
  entityType: string;
};

export type AliasSpec = {
  entityId: string; // pointer_key
  alias: string;
};

export type PublicationDeclaration = {
  episodeId: string; // local ref
  visibilityScope: VisibilityScope;
  content: string;
};

// Probe query
export type StoryProbe = {
  id: string;
  query: string;
  retrievalMethod: "narrative_search" | "cognition_search" | "memory_read" | "memory_explore";
  viewerPerspective: string; // pointer_key of querying character
  expectedFragments: (string | string[])[]; // substrings expected in top-K hits — array = any-of (OR match)
  expectedMissing?: string[]; // should NOT appear in top-K hits
  topK: number;
  expectedConflictFields?: {
    hasConflictSummary?: boolean;
    expectedFactorRefs?: string[];
    hasResolution?: boolean;
  };
};

// Event relations between beats
export type EventRelation = {
  fromBeatId: string;
  toBeatId: string;
  relationType: "causal" | "temporal_prev" | "temporal_next" | "same_episode";
};

export type ToolCallPattern = {
  mustContain?: string[];
  mustNotContain?: string[];
  minCalls?: number;
  maxCalls?: number;
};

export type ReasoningChainProbe = {
  id: string;
  description: string;
  expectedCognitions: {
    cognitionKey: string;
    expectedStance: AssertionStance;
  }[];
  expectEdges?: boolean;
  expectedEdges?: {
    fromEpisodeLocalRef: string;
    toEpisodeLocalRef: string;
    edgeType: LogicEdgeType;
  }[];
};

// The full story definition
export type Story = {
  id: string; // used for cache file naming
  title: string;
  description: string;
  language?: string; // e.g. "Chinese/中文", "English" — guides LLM output language
  characters: StoryCharacter[];
  locations: StoryLocation[];
  clues: StoryClue[];
  beats: StoryBeat[];
  probes: StoryProbe[];
  reasoningChainProbes?: ReasoningChainProbe[];
  eventRelations?: EventRelation[];
};
