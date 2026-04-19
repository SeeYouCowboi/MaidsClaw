import { SCENARIO_ENGINE_BASE_TIME } from "../constants.js";
import type { AssertionSpec, Story, StoryBeat } from "../dsl/story-types.js";

const TOTAL_CHAINS = 30;
const BEATS_PER_CHAIN = 4;
const CHINESE_CHAIN_END = 18;

const CORRECTION_CHAIN_SET = new Set([1, 2, 3, 4, 5, 6, 11, 12, 13]);
const RECOVERY_CHAIN = 7;
const SKETCH_CHAIN_SET = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const FAKE_REF_CHAIN_SET = new Set([8, 9, 10]);
const REAL_EPISODE_REF_CHAIN_SET = new Set([11, 12, 13]);
const COGNITION_REF_ONLY_CHAIN_SET = new Set([14, 15, 16]);
const SKETCH_EXPLICIT_CHAIN_SET = new Set([17, 18]);

const CHINESE_CHARACTERS = [
  {
    id: "detective_lin",
    displayName: "林探长",
    entityType: "person" as const,
    surfaceMotives: "在临安府侦案中维护认知护栏与可追溯审计。",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["林漱雪", "林大人"],
  },
  {
    id: "observer_mo",
    displayName: "李如意",
    entityType: "person" as const,
    surfaceMotives: "持续补充口供与细节，触发认知更新与回滚路径。",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["如意", "李姑娘"],
  },
  {
    id: "steward_chen",
    displayName: "陈管家",
    entityType: "person" as const,
    surfaceMotives: "提供账册与出入记录，协助确认事实锚点。",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["陈伯"],
  },
  {
    id: "cook_qian",
    displayName: "钱厨师",
    entityType: "person" as const,
    surfaceMotives: "说明后厨夜间动线，澄清误导性推断。",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["老钱"],
  },
];

const LOCATIONS = [
  {
    id: "lin_an_office",
    displayName: "临安府审讯室",
    entityType: "location" as const,
    visibilityScope: "area_visible" as const,
  },
  {
    id: "plum_tower",
    displayName: "梅香楼",
    entityType: "location" as const,
    visibilityScope: "area_visible" as const,
  },
  {
    id: "ledger_room",
    displayName: "账册室",
    entityType: "location" as const,
    visibilityScope: "area_visible" as const,
  },
  {
    id: "kitchen_backdoor",
    displayName: "后厨偏门",
    entityType: "location" as const,
    visibilityScope: "area_visible" as const,
  },
];

const CLUES = [
  {
    id: "ledger_note",
    displayName: "账册残页",
    entityType: "item" as const,
    initialLocationId: "ledger_room",
    description: "用于检测认知写入、争议翻转与审计回溯的固定线索。",
  },
];

function chainNo(chain: number): string {
  return String(chain).padStart(2, "0");
}

function primaryKey(chain: number): string {
  return `cg:assertion:${chainNo(chain)}`;
}

function englishAuditChainBeats(chain: number): StoryBeat[] {
  const no = chainNo(chain);
  const key = primaryKey(chain);
  const roundBase = (chain - 1) * BEATS_PER_CHAIN;
  const timeBase = SCENARIO_ENGINE_BASE_TIME + roundBase * 10_000;

  return [
    {
      id: `cg-${no}-b1`,
      phase: "A",
      round: roundBase + 1,
      timestamp: timeBase + 10_000,
      locationId: "lin_an_office",
      participantIds: ["detective_lin", "observer_mo"],
      dialogueGuidance: `English audit chain ${no}: establish deterministic baseline claim.`,
      memoryEffects: {
        episodes: [
          {
            id: `cg-${no}-ep1`,
            category: "speech",
            summary: `English chain ${no}: baseline claim entered into audit trail.`,
            observerIds: ["detective_lin", "observer_mo"],
            timestamp: timeBase + 10_000,
            locationId: "lin_an_office",
          },
        ],
        assertions: [
          {
            cognitionKey: key,
            holderId: "__self__",
            claim: `English chain ${no} baseline claim: ledger_note movement is deterministic.`,
            entityIds: ["ledger_note", "lin_an_office", "observer_mo"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: `cg-${no}-ep1`,
          },
        ],
      },
    },
    {
      id: `cg-${no}-b2`,
      phase: "B",
      round: roundBase + 2,
      timestamp: timeBase + 20_000,
      locationId: "ledger_room",
      participantIds: ["detective_lin", "observer_mo"],
      dialogueGuidance: `English audit chain ${no}: contradict baseline and mark contested.`,
      memoryEffects: {
        episodes: [
          {
            id: `cg-${no}-ep2`,
            category: "observation",
            summary: `English chain ${no}: contradictory context appears in ledger room.`,
            observerIds: ["detective_lin", "observer_mo"],
            timestamp: timeBase + 20_000,
            locationId: "ledger_room",
          },
        ],
        assertions: [
          {
            cognitionKey: key,
            holderId: "__self__",
            claim: `English chain ${no} contradiction challenges prior deterministic baseline.`,
            entityIds: ["ledger_note", "ledger_room", "observer_mo"],
            stance: "contested",
            preContestedStance: "accepted",
            basis: "inference",
            sourceEpisodeId: `cg-${no}-ep2`,
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: `cg-${no}-ep1`,
            toEpisodeId: `cg-${no}-ep2`,
            edgeType: "contradict",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: `cg-${no}-b3`,
      phase: "C",
      round: roundBase + 3,
      timestamp: timeBase + 30_000,
      locationId: "lin_an_office",
      participantIds: ["detective_lin"],
      dialogueGuidance: `English audit chain ${no}: reject the contested statement.`,
      memoryEffects: {
        episodes: [
          {
            id: `cg-${no}-ep3`,
            category: "state_change",
            summary: `English chain ${no}: contested statement resolved to rejected.`,
            observerIds: ["detective_lin"],
            timestamp: timeBase + 30_000,
            locationId: "lin_an_office",
          },
        ],
        assertions: [
          {
            cognitionKey: key,
            holderId: "__self__",
            claim: `English chain ${no} deterministic rejection recorded for audit.`,
            entityIds: ["ledger_note", "lin_an_office"],
            stance: "rejected",
            basis: "inference",
            sourceEpisodeId: `cg-${no}-ep3`,
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: `cg-${no}-ep2`,
            toEpisodeId: `cg-${no}-ep3`,
            edgeType: "causal",
            weight: 0.95,
          },
        ],
      },
    },
    {
      id: `cg-${no}-b4`,
      phase: "D",
      round: roundBase + 4,
      timestamp: timeBase + 40_000,
      locationId: "lin_an_office",
      participantIds: ["detective_lin"],
      dialogueGuidance: `English audit chain ${no}: retract while preserving event history.`,
      memoryEffects: {
        episodes: [
          {
            id: `cg-${no}-ep4`,
            category: "state_change",
            summary: `English chain ${no}: rejected assertion retracted; history preserved.`,
            observerIds: ["detective_lin"],
            timestamp: timeBase + 40_000,
            locationId: "lin_an_office",
          },
        ],
        retractions: [
          {
            cognitionKey: key,
            kind: "assertion",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: `cg-${no}-ep3`,
            toEpisodeId: `cg-${no}-ep4`,
            edgeType: "causal",
            weight: 0.8,
          },
        ],
      },
    },
  ];
}

function chineseMysteryChainBeats(chain: number): StoryBeat[] {
  const no = chainNo(chain);
  const key = primaryKey(chain);
  const roundBase = (chain - 1) * BEATS_PER_CHAIN;
  const timeBase = SCENARIO_ENGINE_BASE_TIME + roundBase * 10_000;

  const hasSketch = SKETCH_CHAIN_SET.has(chain);
  const hasFakeRef = FAKE_REF_CHAIN_SET.has(chain);
  const hasRealEpisodeRef = REAL_EPISODE_REF_CHAIN_SET.has(chain);
  const hasCognitionOnlyRef = COGNITION_REF_ONLY_CHAIN_SET.has(chain);
  const hasSketchExplicit = SKETCH_EXPLICIT_CHAIN_SET.has(chain);
  const isBatchWindow = chain === 6;
  const isRecovery = chain === RECOVERY_CHAIN;
  const hasBeat2Correction = CORRECTION_CHAIN_SET.has(chain);

  const ep1 = `cg-${no}-ep1`;
  const ep2 = `cg-${no}-ep2`;
  const ep3 = `cg-${no}-ep3`;
  const ep4 = `cg-${no}-ep4`;

  const beat1Primary: AssertionSpec = {
    cognitionKey: key,
    holderId: "__self__",
    claim: `林探长初判：链${no}中梅香楼后厨昨夜出现可疑动线。`,
    entityIds: ["ledger_note", "plum_tower", "kitchen_backdoor"],
    stance: "accepted",
    basis:
      hasSketch || hasFakeRef || hasCognitionOnlyRef || hasSketchExplicit
        ? "inference"
        : "first_hand",
    provenance: hasSketch
      ? "talker_sketch_auto"
      : hasSketchExplicit
        ? "talker_sketch_explicit"
        : hasRealEpisodeRef
          ? "explicit_settlement"
          : "thinker_inferred",
    ...(hasRealEpisodeRef ? { sourceEpisodeId: ep1 } : {}),
    ...(hasFakeRef
      ? {
          claimedGroundingRefs: [
            {
              kind: "private_episode",
              ref: `episode:fake_${900 + chain}`,
            },
          ],
        }
      : hasCognitionOnlyRef
        ? {
            claimedGroundingRefs: [
              {
                kind: "existing_cognition",
                ref: "cognition:cg:assertion:01",
              },
            ],
          }
        : {}),
  };

  const beat1Assertions: AssertionSpec[] = [beat1Primary];
  if (isBatchWindow) {
    beat1Assertions.push(
      {
        cognitionKey: "cg:batch:06:a",
        holderId: "__self__",
        claim: "林探长补记：账册室东侧木柜有被翻动痕迹。",
        entityIds: ["ledger_room", "ledger_note"],
        stance: "accepted",
        basis: "inference",
        provenance: "talker_sketch_auto",
      },
      {
        cognitionKey: "cg:batch:06:b",
        holderId: "__self__",
        claim: "林探长补记：陈管家在三更后短暂离开审讯室。",
        entityIds: ["steward_chen", "lin_an_office"],
        stance: "accepted",
        basis: "inference",
        provenance: "talker_sketch_auto",
      },
    );
  }

  const beat2Assertions: AssertionSpec[] = [];
  if (isRecovery) {
    beat2Assertions.push({
      cognitionKey: key,
      holderId: "__self__",
      claim: `链${no}出现冲突口供：先前后厨动线被新证词质疑。`,
      entityIds: ["kitchen_backdoor", "observer_mo"],
      stance: "contested",
      preContestedStance: "accepted",
      basis: "inference",
      provenance: "thinker_inferred",
    });
  } else if (hasBeat2Correction) {
    beat2Assertions.push({
      cognitionKey: key,
      holderId: "__self__",
      claim: `李如意补充后，链${no}改记为：可疑动线发生在账册室而非后厨偏门。`,
      entityIds: ["ledger_room", "observer_mo", "ledger_note"],
      stance: "accepted",
      basis: "first_hand",
      provenance: "user_stated",
    });
  }

  const beat3Assertions: AssertionSpec[] = [];
  if (isRecovery) {
    beat3Assertions.push({
      cognitionKey: key,
      holderId: "__self__",
      claim: `链${no}隔一拍后复核：可疑动线重新确认为账册室外廊。`,
      entityIds: ["ledger_room", "observer_mo", "steward_chen"],
      stance: "accepted",
      basis: "first_hand",
      provenance: "user_stated",
    });
  }

  const beat2Dialogue = hasBeat2Correction
    ? chain <= 6
      ? `链${no}：李如意补充昨夜时序，林探长据新增细节重写该条认知。`
      : `链${no}：李如意当庭改口，林探长据口供变化更新当前判断。`
    : isRecovery
      ? `链${no}：陈管家提出相反证词，先前判断进入争议状态。`
      : `链${no}：众人对线索去向继续盘问，暂不追加新断言。`;

  return [
    {
      id: `cg-${no}-b1`,
      phase: "A",
      round: roundBase + 1,
      timestamp: timeBase + 10_000,
      locationId: "lin_an_office",
      participantIds: ["detective_lin", "observer_mo", "steward_chen"],
      dialogueGuidance: `链${no}：临安府夜审开场，先记一条初始推断并锁定检索实体。`,
      memoryEffects: {
        episodes: [
          {
            id: ep1,
            category: "speech",
            summary: `链${no}首轮问讯：林探长记录关于梅香楼夜间动线的初判。`,
            observerIds: ["detective_lin", "observer_mo", "steward_chen"],
            timestamp: timeBase + 10_000,
            locationId: "lin_an_office",
          },
        ],
        assertions: beat1Assertions,
      },
    },
    {
      id: `cg-${no}-b2`,
      phase: "B",
      round: roundBase + 2,
      timestamp: timeBase + 20_000,
      locationId: "ledger_room",
      participantIds: ["detective_lin", "observer_mo", "cook_qian"],
      dialogueGuidance: beat2Dialogue,
      memoryEffects: {
        episodes: [
          {
            id: ep2,
            category: "observation",
            summary: `链${no}第二拍：账册室出现新线索，促成口供冲突或补全。`,
            observerIds: ["detective_lin", "observer_mo", "cook_qian"],
            timestamp: timeBase + 20_000,
            locationId: "ledger_room",
          },
        ],
        assertions: beat2Assertions,
        logicEdges: [
          {
            fromEpisodeId: ep1,
            toEpisodeId: ep2,
            edgeType: "contradict",
            weight: 0.86,
          },
        ],
      },
    },
    {
      id: `cg-${no}-b3`,
      phase: "C",
      round: roundBase + 3,
      timestamp: timeBase + 30_000,
      locationId: "plum_tower",
      participantIds: ["detective_lin", "observer_mo"],
      dialogueGuidance: isRecovery
        ? `链${no}：经过一拍空档后重回现场，重新主张争议条目并落地新依据。`
        : `链${no}：转至梅香楼复盘，保留证据链因果，不强行新增结论。`,
      memoryEffects: {
        episodes: [
          {
            id: ep3,
            category: "state_change",
            summary: `链${no}第三拍：梅香楼复盘形成新的时序解释。`,
            observerIds: ["detective_lin", "observer_mo"],
            timestamp: timeBase + 30_000,
            locationId: "plum_tower",
          },
        ],
        assertions: beat3Assertions,
        logicEdges: [
          {
            fromEpisodeId: ep2,
            toEpisodeId: ep3,
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: `cg-${no}-b4`,
      phase: "D",
      round: roundBase + 4,
      timestamp: timeBase + 40_000,
      locationId: "lin_an_office",
      participantIds: ["detective_lin", "steward_chen"],
      dialogueGuidance: `链${no}：审讯收束，写入最终审计快照并保持可追溯历史。`,
      memoryEffects: {
        episodes: [
          {
            id: ep4,
            category: "state_change",
            summary: `链${no}终拍：临安府形成可追溯审计节点。`,
            observerIds: ["detective_lin", "steward_chen"],
            timestamp: timeBase + 40_000,
            locationId: "lin_an_office",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: ep3,
            toEpisodeId: ep4,
            edgeType: "causal",
            weight: 0.82,
          },
        ],
      },
    },
  ];
}

const beats: StoryBeat[] = [];
for (let chain = 1; chain <= TOTAL_CHAINS; chain += 1) {
  beats.push(
    ...(chain <= CHINESE_CHAIN_END
      ? chineseMysteryChainBeats(chain)
      : englishAuditChainBeats(chain)),
  );
}

export const COGNITION_GUARDRAILS_ENGLISH_KEYS = Array.from(
  { length: TOTAL_CHAINS - CHINESE_CHAIN_END },
  (_, i) => primaryKey(CHINESE_CHAIN_END + i + 1),
);

export const COGNITION_GUARDRAILS_CORRECTION_KEYS = [
  primaryKey(1),
  primaryKey(2),
  primaryKey(3),
  primaryKey(4),
  primaryKey(5),
  primaryKey(6),
  primaryKey(7),
  primaryKey(11),
  primaryKey(12),
  primaryKey(13),
];

export const COGNITION_GUARDRAILS_SKETCH_WEAK_KEYS = [
  primaryKey(8),
  primaryKey(9),
  primaryKey(10),
  primaryKey(17),
  primaryKey(18),
  "cg:batch:06:a",
  "cg:batch:06:b",
];

export const COGNITION_GUARDRAILS_FAKE_REF_KEYS = [
  primaryKey(8),
  primaryKey(9),
  primaryKey(10),
];

export const COGNITION_GUARDRAILS_COGNITION_ONLY_REF_KEYS = [
  primaryKey(14),
  primaryKey(15),
  primaryKey(16),
];

export const cognitionGuardrails: Story = {
  id: "cognition-guardrails",
  title: "临安府认知护栏长程审计",
  description:
    "30 链 × 4 拍（120 beats）场景：前 18 链为中文悬疑 RP，后 12 链保留英文审计基线，覆盖草图幻觉、静默修正、批量坍缩、恢复间隙、真假 grounding refs 与历史回溯。",
  language: "Chinese/中文 + English",
  characters: CHINESE_CHARACTERS,
  locations: LOCATIONS,
  clues: CLUES,
  beats,
  probes: [],
};
