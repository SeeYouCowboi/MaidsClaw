import type { Story } from "../dsl/story-types.js";
import { SCENARIO_ENGINE_BASE_TIME } from "../constants.js";

/**
 * 对抗 / 负面测试故事集（P0-3）
 *
 * 每条故事针对一种引擎需要「正确拒绝 / 降级 / 隔离」的异常输入设计：
 *
 * 1. adversarialContestedRefuted
 *    完整走完 accepted → contested → rejected 翻案链，同时覆盖
 *    另一条 tentative → accepted 的重新采信路径。用于验证：
 *      - contested 的 preContestedStance 记录
 *      - 多条 cognitionKey 在同一故事中独立推进
 *      - 跨 beat 的 logic edge（contradict / reinforce）
 *      - 评价随推理更新（trustworthiness 升降）
 *
 * 2. adversarialPollutedRetrieval
 *    建立一条 assertion / evaluation / commitment 三类认知都齐全的
 *    合法基线，用于让 runtime 测试注入伪造行，断言：
 *      - auditCognitionGraph 能识别污染
 *      - cognition-search 的 allowedSourceRefPrefixes 能过滤掉污染
 *      - 合法内容在过滤后仍能被检索命中
 *
 * 3. adversarialTimeoutRecovery
 *    5 个互不交叉的 beat，runtime 测试让 b2 和 b4 抛 429，
 *    断言 b1 / b3 / b5 不受影响。beat 之间刻意没有 logic edge 和
 *    共享 cognitionKey，确保失败隔离可以通过 SQL 精确观察。
 */

const CHARS = {
  detective: {
    id: "detective_lin",
    displayName: "林漱雪",
    entityType: "person" as const,
    surfaceMotives: "查明夜间失窃案的真相",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["林探员", "漱雪"],
  },
  maid: {
    id: "maid_amei",
    displayName: "女仆阿梅",
    entityType: "person" as const,
    surfaceMotives: "维持日常家务，回避被追问午夜行踪",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["阿梅"],
  },
  cook: {
    id: "cook_laochen",
    displayName: "厨师老陈",
    entityType: "person" as const,
    surfaceMotives: "准备夜宵，守住厨房的秩序",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["老陈"],
  },
  butler: {
    id: "butler_shi",
    displayName: "史管家",
    entityType: "person" as const,
    surfaceMotives: "保护府邸资产，协助侦探澄清事实",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["史管家"],
  },
};

export const adversarialContestedRefuted: Story = {
  id: "adversarial-contested-refuted",
  title: "对抗：断言翻案链",
  language: "Chinese/中文",
  description:
    "林漱雪侦探在一桩午夜失窃案中，对女仆阿梅的酒窖口供从 accepted 一路推翻至 rejected。同时厨师老陈原本不被重视的 tentative 陈述在新证据下被重新采信。用于验证 DSL 与引擎对完整 stance 翻案链的支持。",
  characters: [CHARS.detective, CHARS.maid, CHARS.cook, CHARS.butler],
  locations: [
    { id: "main_hall", displayName: "正厅", entityType: "location", visibilityScope: "area_visible" },
    { id: "cellar", displayName: "酒窖", entityType: "location", visibilityScope: "area_visible" },
    { id: "kitchen", displayName: "厨房", entityType: "location", visibilityScope: "area_visible" },
    { id: "upstairs_corridor", displayName: "二楼走廊", entityType: "location", visibilityScope: "area_visible" },
  ],
  clues: [
    {
      id: "silver_opener",
      displayName: "银制信封刀",
      entityType: "item",
      initialLocationId: "main_hall",
      description: "正厅书桌上遗失的银制信封刀，是本案的核心赃物。",
    },
  ],
  beats: [
    {
      id: "b1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "main_hall",
      participantIds: ["detective_lin", "maid_amei"],
      dialogueGuidance:
        "林漱雪在正厅初次盘问阿梅，阿梅声称自己午夜下酒窖给客人取了一瓶勃艮第红酒",
      memoryEffects: {
        episodes: [
          {
            id: "b1_ep",
            category: "speech",
            summary: "阿梅当面陈述：午夜十二点前后自己在酒窖为客人取了一瓶勃艮第红酒",
            observerIds: ["detective_lin", "maid_amei"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "main_hall",
          },
        ],
        assertions: [
          {
            cognitionKey: "mei_cellar_at_midnight",
            holderId: "__self__",
            claim: "女仆阿梅午夜十二点前后下到酒窖取了一瓶勃艮第红酒",
            entityIds: ["maid_amei", "cellar"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b1_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "detective_lin",
            objectId: "maid_amei",
            dimensions: [{ name: "trustworthiness", value: 0.6 }],
            sourceEpisodeId: "b1_ep",
          },
        ],
      },
    },
    {
      id: "b2",
      phase: "A",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
      locationId: "kitchen",
      participantIds: ["detective_lin", "cook_laochen"],
      dialogueGuidance:
        "林漱雪转到厨房盘问老陈，老陈说自己当时在准备夜宵，但无意中提到二楼好像有脚步声",
      memoryEffects: {
        episodes: [
          {
            id: "b2_ep",
            category: "speech",
            summary: "老陈声称自己午夜时在厨房准备夜宵，并提到听见二楼走廊传来脚步声",
            observerIds: ["detective_lin", "cook_laochen"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
            locationId: "kitchen",
          },
        ],
        assertions: [
          {
            cognitionKey: "cook_in_kitchen_at_midnight",
            holderId: "__self__",
            claim: "厨师老陈午夜时在厨房准备夜宵",
            entityIds: ["cook_laochen", "kitchen"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b2_ep",
          },
          {
            cognitionKey: "upstairs_footsteps_at_midnight",
            holderId: "__self__",
            claim: "老陈称午夜时听见二楼走廊传来脚步声",
            entityIds: ["cook_laochen", "upstairs_corridor"],
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "b2_ep",
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "B",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
      locationId: "main_hall",
      participantIds: ["detective_lin", "butler_shi"],
      dialogueGuidance:
        "史管家拿出钟楼自动照相机的午夜照片——画面清晰地显示阿梅正在二楼走廊，这与阿梅的酒窖口供直接矛盾",
      memoryEffects: {
        episodes: [
          {
            id: "b3_ep",
            category: "observation",
            summary: "史管家出示钟楼自动照相机午夜照片，照片背景清晰地显示阿梅身处二楼走廊",
            observerIds: ["detective_lin", "butler_shi"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
            locationId: "main_hall",
          },
        ],
        assertions: [
          {
            cognitionKey: "mei_cellar_at_midnight",
            holderId: "__self__",
            claim: "阿梅的酒窖口供与钟楼照片冲突——她实际上出现在二楼走廊",
            entityIds: ["maid_amei", "upstairs_corridor"],
            stance: "contested",
            preContestedStance: "accepted",
            basis: "inference",
            sourceEpisodeId: "b3_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "detective_lin",
            objectId: "butler_shi",
            dimensions: [{ name: "trustworthiness", value: 0.85 }],
            sourceEpisodeId: "b3_ep",
          },
          {
            subjectId: "detective_lin",
            objectId: "maid_amei",
            dimensions: [{ name: "trustworthiness", value: 0.3 }],
            sourceEpisodeId: "b3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b1_ep",
            toEpisodeId: "b3_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: "b4",
      phase: "B",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
      locationId: "cellar",
      participantIds: ["detective_lin"],
      dialogueGuidance:
        "林漱雪独自下酒窖核查红酒台账，台账显示午夜前后没有任何取酒记录——阿梅的酒窖口供被彻底推翻",
      memoryEffects: {
        episodes: [
          {
            id: "b4_ep",
            category: "observation",
            summary: "林漱雪检查酒窖的勃艮第红酒取用台账，午夜前后没有任何取酒签名",
            observerIds: ["detective_lin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
            locationId: "cellar",
          },
        ],
        assertions: [
          {
            cognitionKey: "mei_cellar_at_midnight",
            holderId: "__self__",
            claim: "红酒台账证实午夜前后没有任何取酒记录——阿梅关于下酒窖的陈述被证伪",
            entityIds: ["maid_amei", "cellar"],
            stance: "rejected",
            basis: "inference",
            sourceEpisodeId: "b4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b3_ep",
            toEpisodeId: "b4_ep",
            edgeType: "causal",
            weight: 0.95,
          },
        ],
      },
    },
    {
      id: "b5",
      phase: "C",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
      locationId: "main_hall",
      participantIds: ["detective_lin"],
      dialogueGuidance:
        "林漱雪重新审视老陈的二楼脚步声陈述：既然阿梅当时确实在二楼走廊，那么老陈的模糊听觉印象现在获得了独立证据支持，被正式采信",
      memoryEffects: {
        episodes: [
          {
            id: "b5_ep",
            category: "state_change",
            summary: "林漱雪整合新证据：老陈的脚步声陈述获得照片与台账的联合支持，被重新采信为可靠线索",
            observerIds: ["detective_lin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
            locationId: "main_hall",
          },
        ],
        assertions: [
          {
            cognitionKey: "upstairs_footsteps_at_midnight",
            holderId: "__self__",
            claim: "老陈听到的二楼脚步声与阿梅实际位置吻合，该观察被正式采信",
            entityIds: ["cook_laochen", "upstairs_corridor", "maid_amei"],
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "b5_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "detective_lin",
            objectId: "cook_laochen",
            dimensions: [{ name: "trustworthiness", value: 0.75 }],
            sourceEpisodeId: "b5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b2_ep",
            toEpisodeId: "b5_ep",
            edgeType: "causal",
            weight: 0.7,
          },
        ],
      },
    },
    {
      id: "b6",
      phase: "C",
      round: 6,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 60_000,
      locationId: "main_hall",
      participantIds: ["detective_lin"],
      dialogueGuidance:
        "林漱雪形成新的假设：阿梅午夜时分在二楼另有目的，她的酒窖谎言是为了掩盖真实行踪",
      memoryEffects: {
        episodes: [
          {
            id: "b6_ep",
            category: "state_change",
            summary: "林漱雪提出新假设：阿梅午夜上楼的真实目的可能与银制信封刀失窃有关",
            observerIds: ["detective_lin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 60_000,
            locationId: "main_hall",
          },
        ],
        assertions: [
          {
            cognitionKey: "mei_alt_purpose_upstairs",
            holderId: "__self__",
            claim: "阿梅午夜上二楼的真实目的尚不清楚，但很可能与银制信封刀失窃有关",
            entityIds: ["maid_amei", "upstairs_corridor", "silver_opener"],
            stance: "hypothetical",
            basis: "inference",
            sourceEpisodeId: "b6_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b4_ep",
            toEpisodeId: "b6_ep",
            edgeType: "causal",
            weight: 0.6,
          },
          {
            fromEpisodeId: "b5_ep",
            toEpisodeId: "b6_ep",
            edgeType: "causal",
            weight: 0.6,
          },
        ],
      },
    },
  ],
  probes: [
    {
      id: "refuted-cellar-claim",
      query: "阿梅 酒窖 午夜 勃艮第 红酒",
      retrievalMethod: "cognition_search",
      viewerPerspective: "detective_lin",
      expectedFragments: ["证伪", "台账"],
      topK: 5,
    },
    {
      id: "upstairs-footsteps-reinstated",
      query: "老陈 二楼 脚步声",
      retrievalMethod: "cognition_search",
      viewerPerspective: "detective_lin",
      expectedFragments: ["脚步声"],
      topK: 5,
    },
  ],
};

const CHARS_GARDEN = {
  detective: CHARS.detective,
  gardener: {
    id: "gardener_wuma",
    displayName: "园丁吴婶",
    entityType: "person" as const,
    surfaceMotives: "照料玫瑰园，打理花坛与茶具",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["吴婶"],
  },
  hermann: {
    id: "young_hermann",
    displayName: "赫敏少爷",
    entityType: "person" as const,
    surfaceMotives: "享受花园下午茶，招待访客",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["赫敏", "少爷"],
  },
};

export const adversarialPollutedRetrieval: Story = {
  id: "adversarial-polluted-retrieval",
  title: "对抗：污染检索基线",
  language: "Chinese/中文",
  description:
    "林漱雪在玫瑰花园下午茶期间为吴婶与赫敏的互动建档，建立一条同时覆盖 assertion / evaluation / commitment 三类认知的合法基线。运行时测试在此之上注入伪造行，验证审计助手与 cognition_search 的 allowedSourceRefPrefixes 过滤。",
  characters: [CHARS_GARDEN.detective, CHARS_GARDEN.gardener, CHARS_GARDEN.hermann],
  locations: [
    { id: "tea_table", displayName: "花园茶台", entityType: "location", visibilityScope: "area_visible" },
    { id: "rose_garden", displayName: "玫瑰园", entityType: "location", visibilityScope: "area_visible" },
    { id: "greenhouse", displayName: "温室", entityType: "location", visibilityScope: "area_visible" },
  ],
  clues: [
    {
      id: "rose_scissors",
      displayName: "玫瑰花剪",
      entityType: "item",
      initialLocationId: "rose_garden",
      description: "吴婶随身携带的银柄玫瑰花剪，事发前后摆放位置异常。",
    },
  ],
  beats: [
    {
      id: "b1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "tea_table",
      participantIds: ["detective_lin", "gardener_wuma", "young_hermann"],
      dialogueGuidance:
        "下午茶开始。赫敏少爷请吴婶为客人沏一壶玫瑰茶，吴婶应允并返回温室取茶叶",
      memoryEffects: {
        episodes: [
          {
            id: "g_b1_ep",
            category: "speech",
            summary: "赫敏少爷请吴婶沏一壶玫瑰茶，吴婶应允后前往温室取茶叶",
            observerIds: ["detective_lin", "gardener_wuma", "young_hermann"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "tea_table",
          },
        ],
        assertions: [
          {
            cognitionKey: "wuma_agreed_to_brew_rose_tea",
            holderId: "__self__",
            claim: "园丁吴婶应赫敏少爷的要求准备沏一壶玫瑰茶",
            entityIds: ["gardener_wuma", "young_hermann", "tea_table"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "g_b1_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "detective_lin",
            objectId: "gardener_wuma",
            dimensions: [
              { name: "trustworthiness", value: 0.7 },
              { name: "cooperation", value: 0.8 },
            ],
            sourceEpisodeId: "g_b1_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "wuma_commit_brew_rose_tea",
            subjectId: "gardener_wuma",
            mode: "intent",
            content: "吴婶承诺尽快从温室取出玫瑰茶叶并沏好送到花园茶台",
            isPrivate: false,
            sourceEpisodeId: "g_b1_ep",
          },
        ],
      },
    },
    {
      id: "b2",
      phase: "A",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
      locationId: "rose_garden",
      participantIds: ["detective_lin"],
      dialogueGuidance:
        "林漱雪独自巡视玫瑰园，注意到吴婶的银柄玫瑰花剪被反放在第三排玫瑰旁的石阶上，剪柄上还沾有新鲜泥土",
      memoryEffects: {
        episodes: [
          {
            id: "g_b2_ep",
            category: "observation",
            summary: "林漱雪在玫瑰园第三排石阶上发现吴婶的银柄玫瑰花剪被反放，剪柄沾有新鲜泥土",
            observerIds: ["detective_lin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
            locationId: "rose_garden",
          },
        ],
        assertions: [
          {
            cognitionKey: "rose_scissors_misplaced",
            holderId: "__self__",
            claim: "银柄玫瑰花剪以反放姿态出现在玫瑰园第三排石阶，且剪柄沾有新鲜泥土",
            entityIds: ["rose_scissors", "rose_garden"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "g_b2_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "detective_lin",
            objectId: "rose_scissors",
            dimensions: [{ name: "evidentiary_value", value: 0.65 }],
            sourceEpisodeId: "g_b2_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "lin_commit_interview_wuma_about_scissors",
            subjectId: "detective_lin",
            mode: "plan",
            content: "林漱雪决定在茶会结束后单独询问吴婶关于玫瑰花剪反放的原因",
            isPrivate: true,
            sourceEpisodeId: "g_b2_ep",
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "B",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
      locationId: "tea_table",
      participantIds: ["detective_lin", "gardener_wuma"],
      dialogueGuidance:
        "林漱雪借端茶具的机会询问吴婶午后是否有访客进入玫瑰园。吴婶犹豫片刻，说记不清，只记得自己一直在温室与茶台之间来回",
      memoryEffects: {
        episodes: [
          {
            id: "g_b3_ep",
            category: "speech",
            summary: "吴婶在被问及午后玫瑰园访客时犹豫并回答记不清，只称自己一直在温室与茶台之间来回",
            observerIds: ["detective_lin", "gardener_wuma"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
            locationId: "tea_table",
          },
        ],
        assertions: [
          {
            cognitionKey: "wuma_vague_about_visitors",
            holderId: "__self__",
            claim: "吴婶对午后玫瑰园是否有访客给出含糊回答，自称一直在温室与茶台之间来回",
            entityIds: ["gardener_wuma", "rose_garden", "greenhouse"],
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "g_b3_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "detective_lin",
            objectId: "gardener_wuma",
            dimensions: [{ name: "trustworthiness", value: 0.55 }],
            sourceEpisodeId: "g_b3_ep",
          },
        ],
      },
    },
  ],
  probes: [
    {
      id: "legit-rose-tea-probe",
      query: "玫瑰 茶 沏茶 吴婶",
      retrievalMethod: "cognition_search",
      viewerPerspective: "detective_lin",
      expectedFragments: ["玫瑰茶"],
      topK: 5,
    },
    {
      id: "legit-scissors-probe",
      query: "花剪 反放 泥土",
      retrievalMethod: "cognition_search",
      viewerPerspective: "detective_lin",
      expectedFragments: ["花剪"],
      topK: 5,
    },
  ],
};

const CHARS_INTERROGATION = {
  detective: CHARS.detective,
  zhang: {
    id: "suspect_zhang",
    displayName: "嫌疑人张",
    entityType: "person" as const,
    surfaceMotives: "否认一切指控，尽快离开审讯室",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["张嫌疑人", "小张"],
  },
  li: {
    id: "suspect_li",
    displayName: "嫌疑人李",
    entityType: "person" as const,
    surfaceMotives: "和张嫌疑人划清界限，撇清共谋指控",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: ["李嫌疑人", "老李"],
  },
};

export const adversarialTimeoutRecovery: Story = {
  id: "adversarial-timeout-recovery",
  title: "对抗：逐 beat 超时/限流隔离",
  language: "Chinese/中文",
  description:
    "一夜审讯笔录，五段互不相干的问话。运行时测试让 LLM provider 在 b2 与 b4 上抛 429 错误，断言 b1 / b3 / b5 仍然成功，即 write-path 的 per-beat try/catch 能正确隔离失败。所有 beat 刻意使用独立的 cognitionKey 与 episode，没有任何跨 beat 的 logic edge，确保失败隔离可以通过 SQL 精确观察。",
  characters: [CHARS_INTERROGATION.detective, CHARS_INTERROGATION.zhang, CHARS_INTERROGATION.li],
  locations: [
    { id: "interrogation_room", displayName: "审讯室", entityType: "location", visibilityScope: "area_visible" },
  ],
  clues: [],
  beats: [
    {
      id: "b1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "interrogation_room",
      participantIds: ["detective_lin", "suspect_zhang"],
      dialogueGuidance: "林漱雪询问张嫌疑人事发当晚的不在场证明",
      memoryEffects: {
        episodes: [
          {
            id: "t_b1_ep",
            category: "speech",
            summary: "张嫌疑人声称事发当晚在「汇丰酒馆」与朋友饮酒直至凌晨",
            observerIds: ["detective_lin", "suspect_zhang"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "interrogation_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "zhang_alibi",
            holderId: "__self__",
            claim: "张嫌疑人自述事发当晚在汇丰酒馆与朋友饮酒直至凌晨",
            entityIds: ["suspect_zhang", "interrogation_room"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "t_b1_ep",
          },
        ],
      },
    },
    {
      id: "b2",
      phase: "A",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
      locationId: "interrogation_room",
      participantIds: ["detective_lin", "suspect_li"],
      dialogueGuidance: "林漱雪询问李嫌疑人事发当晚的不在场证明——该 beat 会被测试强制失败",
      memoryEffects: {
        episodes: [
          {
            id: "t_b2_ep",
            category: "speech",
            summary: "李嫌疑人声称事发当晚独自在公寓看书",
            observerIds: ["detective_lin", "suspect_li"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
            locationId: "interrogation_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "li_alibi",
            holderId: "__self__",
            claim: "李嫌疑人自述事发当晚独自在公寓看书，没有其他证人",
            entityIds: ["suspect_li", "interrogation_room"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "t_b2_ep",
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "A",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
      locationId: "interrogation_room",
      participantIds: ["detective_lin", "suspect_zhang"],
      dialogueGuidance: "林漱雪追问张嫌疑人与被害人之间是否有金钱往来",
      memoryEffects: {
        episodes: [
          {
            id: "t_b3_ep",
            category: "speech",
            summary: "张嫌疑人承认三个月前曾向被害人借过五千元但已经还清",
            observerIds: ["detective_lin", "suspect_zhang"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
            locationId: "interrogation_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "zhang_debt_history",
            holderId: "__self__",
            claim: "张嫌疑人承认三个月前曾向被害人借过五千元并声称已经还清",
            entityIds: ["suspect_zhang"],
            stance: "tentative",
            basis: "first_hand",
            sourceEpisodeId: "t_b3_ep",
          },
        ],
      },
    },
    {
      id: "b4",
      phase: "A",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
      locationId: "interrogation_room",
      participantIds: ["detective_lin", "suspect_li"],
      dialogueGuidance: "林漱雪追问李嫌疑人近期有无与被害人接触——该 beat 会被测试强制失败",
      memoryEffects: {
        episodes: [
          {
            id: "t_b4_ep",
            category: "speech",
            summary: "李嫌疑人声称三个月来没有见过被害人",
            observerIds: ["detective_lin", "suspect_li"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
            locationId: "interrogation_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "li_recent_contact",
            holderId: "__self__",
            claim: "李嫌疑人声称近三个月没有与被害人接触",
            entityIds: ["suspect_li"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "t_b4_ep",
          },
        ],
      },
    },
    {
      id: "b5",
      phase: "A",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
      locationId: "interrogation_room",
      participantIds: ["detective_lin", "suspect_zhang", "suspect_li"],
      dialogueGuidance: "林漱雪将两人带到一起询问他们之间的关系",
      memoryEffects: {
        episodes: [
          {
            id: "t_b5_ep",
            category: "speech",
            summary: "张李两人同时承认曾在同一家工厂共事一年，但均否认事发前后有任何联系",
            observerIds: ["detective_lin", "suspect_zhang", "suspect_li"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
            locationId: "interrogation_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "zhang_li_past_relationship",
            holderId: "__self__",
            claim: "张李两人承认曾在同一家工厂共事一年，但均否认事发前后有联系",
            entityIds: ["suspect_zhang", "suspect_li"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "t_b5_ep",
          },
        ],
      },
    },
  ],
  probes: [],
};
