import { SCENARIO_ENGINE_BASE_TIME } from "../constants.js";
import type { Story } from "../dsl/story-types.js";

/**
 * 《第七日》—— 孤岛疑云
 *
 * 主因果链：
 * 郑远洋（已死）-> 储藏室钥匙分配（3把钥匙）-> 相互猜疑 ->
 * 数字纸条 -> 电脑密码 -> 保险文件 / 伪造转账记录 ->
 * 泥脚印（证明第三人存在）-> 郑远洋日记（揭露替罪羊真相）->
 * 隐藏的U盘（录音）-> 陈卫国落网（真凶）
 *
 * 信任弧线：
 * 敌对 -> 警惕 -> 试探性合作 -> 危机（伪造转账）->
 * 恢复（第三人证据）-> 谨慎的尊重 -> 结盟
 *
 * 身份揭露：
 * - 徐然：气象员伪装 -> 深蓝哨兵组织调查员
 * - 玩家角色：海洋生物学家伪装 -> 记者
 * - 陈卫国：前站长 -> 远潮生物科技"清道夫" / 真凶
 */
export const islandSuspicion: Story = {
  id: "island-suspicion",
  title: "第七日",
  description:
    "一场发生在孤立海洋研究站的七十回合悬疑剧。两名幸存者——一位卧底环保调查员和一位伪装的记者——必须在相互猜疑、栽赃陷害与一个隐藏的第三杀手之间周旋求生，而救援的补给船还有四天才能抵达。",
  characters: [
    {
      id: "xu_ran",
      displayName: "徐然",
      entityType: "person",
      surfaceMotives:
        "研究站气象员，在首席研究员遇害后努力求生，对这位恰好在命案前夜抵达的新来者心存戒备",
      hiddenCommitments: [
        {
          cognitionKey: "xu_ran_protect_identity",
          subjectId: "xu_ran",
          mode: "constraint",
          content:
            "不惜一切代价隐瞒自己与深蓝哨兵环保组织的关联",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
        {
          cognitionKey: "xu_ran_find_truth",
          subjectId: "xu_ran",
          mode: "goal",
          content:
            "在补给船到达之前，找到远潮生物科技非法深海采样的证据",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
        {
          cognitionKey: "xu_ran_survive",
          subjectId: "xu_ran",
          mode: "goal",
          content:
            "在可能有杀手的孤岛上活过四天",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
        {
          cognitionKey: "xu_ran_info_broker",
          subjectId: "xu_ran",
          mode: "plan",
          content:
            "奉行对等的信息交换原则——绝不白白透露任何情报",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "xu_ran",
          objectId: "player_char",
          dimensions: [
            { name: "trustworthiness", value: 0.15 },
            { name: "threat_level", value: 0.8 },
          ],
          sourceEpisodeId: undefined,
        },
        {
          subjectId: "xu_ran",
          objectId: "xu_ran",
          dimensions: [{ name: "composure", value: 0.85 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["气象员徐然", "深蓝哨兵特工"],
    },
    {
      id: "player_char",
      displayName: "玩家角色",
      entityType: "person",
      surfaceMotives:
        "新到站的海洋生物学家，到达研究站的第一天就撞上了一桩命案",
      hiddenCommitments: [
        {
          cognitionKey: "player_journalist_mission",
          subjectId: "player_char",
          mode: "goal",
          content:
            "以海洋生物学家身份为掩护，以记者身份调查远潮生物科技的非法活动",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "xu_ran",
          objectId: "player_char",
          dimensions: [{ name: "suspiciousness", value: 0.75 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["新来的生物学家", "记者"],
    },
    {
      id: "zheng_yuanyang",
      displayName: "郑远洋",
      entityType: "person",
      surfaceMotives:
        "海洋研究站首席研究员——被发现死在样本储藏室中，后脑遭钝器重击",
      hiddenCommitments: [
        {
          cognitionKey: "zheng_scapegoat_burden",
          subjectId: "zheng_yuanyang",
          mode: "constraint",
          content:
            "被胁迫为远潮生物科技伪造数据，但暗中保留了证据作为自保的筹码",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [],
      aliases: ["首席研究员郑远洋", "老郑"],
    },
  ],
  locations: [
    {
      id: "research_station",
      displayName: "研究站（主楼）",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "meteorological_platform",
      displayName: "气象观测平台",
      entityType: "location",
      parentLocationId: "research_station",
      visibilityScope: "area_visible",
    },
    {
      id: "sample_storage",
      displayName: "样本储藏室",
      entityType: "location",
      parentLocationId: "research_station",
      visibilityScope: "area_visible",
    },
    {
      id: "office",
      displayName: "郑远洋办公室",
      entityType: "location",
      parentLocationId: "research_station",
      visibilityScope: "area_visible",
    },
    {
      id: "laboratory",
      displayName: "实验室",
      entityType: "location",
      parentLocationId: "research_station",
      visibilityScope: "area_visible",
    },
    {
      id: "radio_room",
      displayName: "无线电室",
      entityType: "location",
      parentLocationId: "research_station",
      visibilityScope: "area_visible",
    },
    {
      id: "dormitory",
      displayName: "宿舍",
      entityType: "location",
      parentLocationId: "research_station",
      visibilityScope: "area_visible",
    },
    {
      id: "north_equipment_shed",
      displayName: "北区设备舱",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "supply_warehouse",
      displayName: "补给仓库",
      entityType: "location",
      visibilityScope: "area_visible",
    },
  ],
  clues: [
    {
      id: "storage_key",
      displayName: "储藏室钥匙",
      entityType: "item",
      initialLocationId: "sample_storage",
      description:
        "共有三把：一把在郑远洋遗体上，一把在徐然手中，一把在玩家手中。钥匙的分配是猜疑的第一条导火索。",
    },
    {
      id: "usb_drive_missing",
      displayName: "丢失的U盘",
      entityType: "item",
      initialLocationId: "office",
      description:
        "原存放于郑远洋的保险柜中，现已不翼而飞。内含远潮生物科技非法采样的关键证据。被陈卫国取走。",
    },
    {
      id: "paper_note",
      displayName: "数字纸条（电脑密码）",
      entityType: "item",
      initialLocationId: "sample_storage",
      description:
        "在郑远洋遗体上发现的一张纸片，上面写着一串数字——实际上是实验室主电脑的密码。",
    },
    {
      id: "zheng_diary",
      displayName: "郑远洋的隐藏日记",
      entityType: "item",
      initialLocationId: "dormitory",
      description:
        "藏在郑远洋房间地板下。揭露他是被迫伪造数据的替罪羊，而非心甘情愿的同谋。日记中提到了在北区设备舱的秘密会面。",
    },
    {
      id: "usb_drive_hidden",
      displayName: "隐藏的U盘（日记中）",
      entityType: "item",
      initialLocationId: "dormitory",
      description:
        "藏在郑远洋日记书脊中的第二个U盘，内含远潮生物科技高层胁迫郑远洋的录音。",
    },
    {
      id: "mud_footprint",
      displayName: "泥脚印（43-44码）",
      entityType: "item",
      initialLocationId: "sample_storage",
      description:
        "储藏室中的一个泥鞋印，尺码43至44。徐然和玩家的鞋码均不符。证明有第三人在场。",
    },
    {
      id: "transfer_record",
      displayName: "伪造转账记录",
      entityType: "object",
      initialLocationId: "laboratory",
      description:
        "郑远洋电脑上的一份伪造文件，显示有一笔资金转入了徐然名下的账户。由陈卫国栽赃伪造。",
    },
  ],

  // ──────────────────────────────────────────────────────────
  // 节拍 — 7个阶段（A至G）共35个节拍，每阶段5个
  // 时间间隔：每个节拍60,000毫秒
  // ──────────────────────────────────────────────────────────
  beats: [
    // ═══════════════════════════════════════════════════════
    // 阶段A：初次对峙与猜疑（第1-10回合）
    // ═══════════════════════════════════════════════════════
    {
      id: "a1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 0 * 60_000,
      locationId: "sample_storage",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "晨光透过结满盐霜的窗户洒入样本储藏室。徐然站在郑远洋的遗体旁，面无表情。玩家推门而入，僵在原地。郑远洋面朝下倒在散落的标本瓶间，后脑塌陷，血液沿着地砖缝隙蔓延开来。两个幸存者隔着死者对视，如同两头在猎物旁相遇的狼——谁都不肯先移开目光。",
      memoryEffects: {
        episodes: [
          {
            id: "a1_ep",
            category: "observation",
            summary:
              "徐然与玩家在样本储藏室发现郑远洋的遗体——后脑被钝器击碎，标本瓶散落一地，血液在地砖上汇聚成洼",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 0 * 60_000,
            locationId: "sample_storage",
          },
        ],
        assertions: [
          {
            cognitionKey: "zheng_murdered",
            subjectId: "zheng_yuanyang",
            objectId: "sample_storage",
            predicate: "被谋杀于",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "a1_ep",
          },
          {
            cognitionKey: "player_suspect",
            subjectId: "player_char",
            objectId: "zheng_yuanyang",
            predicate: "可能杀害了",
            stance: "hypothetical",
            basis: "inference",
            sourceEpisodeId: "a1_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.1 },
              { name: "threat_level", value: 0.85 },
            ],
            sourceEpisodeId: "a1_ep",
          },
        ],
      },
    },
    {
      id: "a2",
      phase: "A",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 1 * 60_000,
      locationId: "sample_storage",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "审讯开始，紧绷而迂回。徐然的声音冷硬而克制：你昨晚在哪？玩家反问：我昨天下午才到——你呢？双方都声称待在自己房间。徐然以冷酷的精确记下了玩家的到站时间——这个新来者在案发前不到十二小时才上岛。玩家则注意到徐然早已在此，早已熟悉一切通道和规律。信任值为负。每一句话都是一步棋。",
      memoryEffects: {
        episodes: [
          {
            id: "a2_ep",
            category: "speech",
            summary:
              "徐然与玩家相互盘问昨夜行踪——双方都声称待在自己房间，谁也无法为对方作证",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 1 * 60_000,
            locationId: "sample_storage",
          },
        ],
        assertions: [
          {
            cognitionKey: "player_alibi_unverified",
            subjectId: "player_char",
            objectId: "dormitory",
            predicate: "声称昨夜待在",
            stance: "hypothetical",
            basis: "hearsay",
            sourceEpisodeId: "a2_ep",
          },
          {
            cognitionKey: "xu_ran_alibi_unverified",
            subjectId: "xu_ran",
            objectId: "dormitory",
            predicate: "声称昨夜待在",
            stance: "hypothetical",
            basis: "introspection",
            sourceEpisodeId: "a2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a1_ep",
            toEpisodeId: "a2_ep",
            edgeType: "temporal_next",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: "a3",
      phase: "A",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 2 * 60_000,
      locationId: "sample_storage",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "钥匙的真相浮出水面。徐然从口袋里掏出一把储藏室钥匙。玩家也有一把——在欢迎包里找到的。三把钥匙去向已明：郑远洋身上一把，徐然一把，玩家一把。徐然眯起眼睛。三把钥匙，其中一把为凶手打开了这扇门。指控不言自明：玩家是外来者。玩家反驳：或者是早已熟知布局的人。两人之间的空气仿佛随时会碎裂。",
      memoryEffects: {
        episodes: [
          {
            id: "a3_ep",
            category: "observation",
            summary:
              "三把储藏室钥匙去向已明——一把在郑远洋遗体上，一把在徐然手中，一把在玩家手中。钥匙的分配使两名幸存者都同等可疑",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 2 * 60_000,
            locationId: "sample_storage",
          },
        ],
        assertions: [
          {
            cognitionKey: "three_keys_accounted",
            subjectId: "storage_key",
            objectId: "sample_storage",
            predicate: "三把钥匙分别在三人手中",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "a3_ep",
          },
          {
            cognitionKey: "player_suspect",
            subjectId: "player_char",
            objectId: "zheng_yuanyang",
            predicate: "具备作案条件",
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "a3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a1_ep",
            toEpisodeId: "a3_ep",
            edgeType: "causal",
            weight: 0.85,
          },
        ],
      },
    },
    {
      id: "a4",
      phase: "A",
      round: 7,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 3 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "走出储藏室，海风裹挟着咸腥与铁锈的气味扑面而来。快艇被人凿沉——船体穿孔，发动机灌满了水。无线电塔的电路板被蓄意、精准地拆除了。他们被困在了岛上。补给船四天后才来。徐然以一种习惯于威胁评估之人的冷静效率消化着这一切。玩家的镇定微微裂开——这是预谋。有人想把他们困死在这里。",
      memoryEffects: {
        episodes: [
          {
            id: "a4_ep",
            category: "observation",
            summary:
              "快艇被凿沉，无线电塔电路板被盗——两名幸存者被困孤岛，无法求援。补给船四天后才能到达",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 3 * 60_000,
            locationId: "research_station",
          },
        ],
        assertions: [
          {
            cognitionKey: "stranded_deliberate",
            subjectId: "research_station",
            objectId: "xu_ran",
            predicate: "困岛是蓄意为之",
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "a4_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "xu_ran_survive",
            subjectId: "xu_ran",
            mode: "goal",
            content:
              "在岛上撑过四天——补给船是唯一的出路",
            isPrivate: false,
            sourceEpisodeId: "a4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a1_ep",
            toEpisodeId: "a4_ep",
            edgeType: "causal",
            weight: 0.8,
          },
        ],
      },
    },
    {
      id: "a5",
      phase: "A",
      round: 10,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 4 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "一个勉强的、有条件的合作协议。徐然提议一起搜查办公室。她的逻辑无懈可击：单独行动，任何一方都可能篡改证据；结伴而行，彼此既是见证者也是监视者。玩家同意了。他们将结伴穿行于研究站，寸步不离。这不是同盟，而是披着务实外衣的相互挟持。",
      memoryEffects: {
        episodes: [
          {
            id: "a5_ep",
            category: "speech",
            summary:
              "徐然与玩家达成紧张的有条件协议，结伴调查研究站——互为彼此的见证者与看守者",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 4 * 60_000,
            locationId: "research_station",
          },
        ],
        commitments: [
          {
            cognitionKey: "conditional_cooperation",
            subjectId: "xu_ran",
            mode: "plan",
            content:
              "与玩家结伴行动——绝不让对方离开视线，将合作视为相互监控",
            isPrivate: false,
            sourceEpisodeId: "a5_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.2 },
              { name: "threat_level", value: 0.7 },
            ],
            sourceEpisodeId: "a5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a2_ep",
            toEpisodeId: "a5_ep",
            edgeType: "causal",
            weight: 0.75,
          },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════
    // 阶段B：信息博弈（第11-20回合）
    // ═══════════════════════════════════════════════════════
    {
      id: "b1",
      phase: "B",
      round: 11,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 5 * 60_000,
      locationId: "office",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "郑远洋的办公室简朴而实用——墙上钉着航海图，桌上堆满文件，一面活动板后方露出一个已被打开的保险柜。柜子空了。徐然以摄影师般的敏锐审视着空柜：灰尘的痕迹显示这里最近放过一个长方形的东西，几乎可以确定是U盘。玩家声称郑远洋在遇害前曾简短提及一个存有关键数据的U盘。徐然将这条信息不动声色地收入脑中，但她的内心天平微微倾斜——如果属实，玩家与郑远洋有过从未披露的接触。",
      memoryEffects: {
        episodes: [
          {
            id: "b1_ep",
            category: "observation",
            summary:
              "徐然与玩家发现郑远洋的保险柜已被打开且空无一物——灰尘痕迹表明一个U盘最近被取走。玩家声称郑远洋死前曾向其提起此U盘",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 5 * 60_000,
            locationId: "office",
          },
        ],
        assertions: [
          {
            cognitionKey: "usb_stolen_from_safe",
            subjectId: "usb_drive_missing",
            objectId: "office",
            predicate: "从保险柜中被取走",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b1_ep",
          },
          {
            cognitionKey: "player_knew_about_usb",
            subjectId: "player_char",
            objectId: "usb_drive_missing",
            predicate: "声称郑远洋曾告知其关于",
            stance: "hypothetical",
            basis: "hearsay",
            sourceEpisodeId: "b1_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a5_ep",
            toEpisodeId: "b1_ep",
            edgeType: "temporal_next",
            weight: 0.85,
          },
        ],
      },
    },
    {
      id: "b2",
      phase: "B",
      round: 13,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 6 * 60_000,
      locationId: "office",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "徐然在郑远洋身上找到一张纸条——上面写着一串数字。她辨认出这可能是密码格式，但并未立即分享。她提出交换：你告诉我郑远洋什么时候联系你、说了什么，我就告诉你这张纸条可能意味着什么。信息掮客的思维清晰如水晶。玩家犹豫片刻，给出部分真相：郑远洋通过一个共同联系人找到自己，说站上有值得曝光的秘密。徐然收下这个信息，作为回报透露：这些数字可能是一个电脑密码。",
      memoryEffects: {
        episodes: [
          {
            id: "b2_ep",
            category: "speech",
            summary:
              "徐然与玩家进行对等的信息交换——徐然指出纸条上的数字可能是电脑密码，玩家则透露郑远洋通过一个共同联系人就站上的秘密联系了自己",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 6 * 60_000,
            locationId: "office",
          },
        ],
        assertions: [
          {
            cognitionKey: "paper_note_is_password",
            subjectId: "paper_note",
            objectId: "laboratory",
            predicate: "可能是电脑密码，对应于",
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "b2_ep",
          },
          {
            cognitionKey: "player_had_prior_contact_with_zheng",
            subjectId: "player_char",
            objectId: "zheng_yuanyang",
            predicate: "在抵达之前就与其有过联系",
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "b2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b1_ep",
            toEpisodeId: "b2_ep",
            edgeType: "causal",
            weight: 0.8,
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "B",
      round: 15,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 7 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "玩家提议正式休战。徐然在研究站走廊上抱臂倾听，海风呼啸而过。玩家的论证合乎逻辑：如果凶手是两人之一，另一个更应紧紧跟随以保安全；如果凶手两人都不是，那他们在浪费精力互相猜疑。徐然的回应审慎克制：我不信任你，但我承认互相残杀于事无补。她提出一个系统化的调查方案——逐个房间搜查，共享发现，禁止单独行动。陌生人之间以必要性为墨签下的契约。",
      memoryEffects: {
        episodes: [
          {
            id: "b3_ep",
            category: "speech",
            summary:
              "玩家提议正式休战。徐然有条件地接受，提出系统性的逐间搜查计划，所有发现共享，禁止单独行动",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 7 * 60_000,
            locationId: "research_station",
          },
        ],
        commitments: [
          {
            cognitionKey: "structured_investigation",
            subjectId: "xu_ran",
            mode: "plan",
            content:
              "对研究站进行逐间系统性搜查，所有发现共享，不允许单独行动",
            isPrivate: false,
            sourceEpisodeId: "b3_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.3 },
              { name: "threat_level", value: 0.55 },
            ],
            sourceEpisodeId: "b3_ep",
          },
        ],
      },
    },
    {
      id: "b4",
      phase: "B",
      round: 17,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 8 * 60_000,
      locationId: "radio_room",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "无线电室证实了他们的孤立无援。电路板是用工具拆除的——不是慌乱中扯断，而是用螺丝刀精确地取出。徐然检查着空空的插槽，自言自语般说道：这是熟悉设备的人干的，不是恐慌之举。玩家指出他们两人都不可能在同一个晚上既破坏快艇又拆掉电路板。徐然捕捉到了其中的暗示，但尚未表态认同。第三人假说的种子已经埋下，只是谁也不敢贸然浇灌。",
      memoryEffects: {
        episodes: [
          {
            id: "b4_ep",
            category: "observation",
            summary:
              "无线电塔电路板被专业手法拆除——是精心的破坏，而非慌乱之举。玩家提出两人不可能在同一个晚上同时破坏快艇和电台，暗示有第三人存在",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 8 * 60_000,
            locationId: "radio_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "sabotage_professional",
            subjectId: "radio_room",
            objectId: "research_station",
            predicate: "被具备专业知识的人蓄意破坏",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b4_ep",
          },
          {
            cognitionKey: "third_person_hypothesis",
            subjectId: "research_station",
            objectId: "zheng_yuanyang",
            predicate: "可能存在与谋杀案相关的未知第三人",
            stance: "hypothetical",
            basis: "inference",
            sourceEpisodeId: "b4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a4_ep",
            toEpisodeId: "b4_ep",
            edgeType: "causal",
            weight: 0.82,
          },
        ],
      },
    },
    {
      id: "b5",
      phase: "B",
      round: 20,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 9 * 60_000,
      locationId: "laboratory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "他们在实验室电脑上输入纸条上的数字。屏幕解锁了。郑远洋的桌面井然有序——研究日志、潮汐数据、气象报告。表面上看不出任何可疑之处。但徐然注意到一个名为「保险」的文件夹，修改时间戳恰好是命案当夜。她没有立即打开，而是在心中标记下来，留作日后的筹码。第一天在脆弱的均势中落幕——两只警觉的动物共享同一处水源。",
      memoryEffects: {
        episodes: [
          {
            id: "b5_ep",
            category: "action",
            summary:
              "纸条上的数字成功解锁了郑远洋的实验室电脑。徐然发现一个名为「保险」的文件夹，修改时间恰在命案当夜，但她暂未打开",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 9 * 60_000,
            locationId: "laboratory",
          },
        ],
        assertions: [
          {
            cognitionKey: "paper_note_is_password",
            subjectId: "paper_note",
            objectId: "laboratory",
            predicate: "已确认为电脑密码，对应于",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "b5_ep",
          },
          {
            cognitionKey: "insurance_folder_suspicious",
            subjectId: "zheng_yuanyang",
            objectId: "laboratory",
            predicate: "在电脑上有一个命案当夜修改过的「保险」文件夹",
            stance: "tentative",
            basis: "first_hand",
            sourceEpisodeId: "b5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b2_ep",
            toEpisodeId: "b5_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════
    // 阶段C：身份压力（第21-30回合）
    // ═══════════════════════════════════════════════════════
    {
      id: "c1",
      phase: "C",
      round: 21,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10 * 60_000,
      locationId: "meteorological_platform",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "第二天清晨。风向转了，带来深海矿物质的气息。在气象观测平台上，玩家开始试探徐然的伪装身份。你这里的设备是标准气象站配置——但这些采样日志记录的是深海热力读数，这可不是气象学的范畴。徐然从容应对：是郑远洋让我交叉比对大气和海洋数据。但玩家在站内的一本笔记中发现了郑远洋亲笔写下的「深蓝哨兵」四个字。他们把这个名字悬在空气中，仿佛一根点燃的引信。",
      memoryEffects: {
        episodes: [
          {
            id: "c1_ep",
            category: "speech",
            summary:
              "玩家以与气象工作不符的深海采样日志质疑徐然的气象员身份。玩家还透露在郑远洋笔记中发现了「深蓝哨兵」字样，直接施压徐然的秘密身份",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10 * 60_000,
            locationId: "meteorological_platform",
          },
        ],
        assertions: [
          {
            cognitionKey: "xu_ran_cover_challenged",
            subjectId: "xu_ran",
            objectId: "meteorological_platform",
            predicate: "气象员的伪装身份遭到有力质疑",
            stance: "tentative",
            basis: "first_hand",
            sourceEpisodeId: "c1_ep",
          },
          {
            cognitionKey: "deep_blue_sentinel_mentioned",
            subjectId: "xu_ran",
            objectId: "zheng_yuanyang",
            predicate: "「深蓝哨兵」之名将其与此人关联",
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "c1_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "perceptiveness", value: 0.8 },
              { name: "threat_level", value: 0.65 },
            ],
            sourceEpisodeId: "c1_ep",
          },
        ],
      },
    },
    {
      id: "c2",
      phase: "C",
      round: 23,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 11 * 60_000,
      locationId: "meteorological_platform",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "徐然既不承认也不否认。她的反击如同精密的建筑结构：就算存在这样一个组织，知道它的名字也解释不了郑远洋为什么会死。她把压力转回去：一个昨天才到的海洋生物学家，为什么知道深蓝哨兵是什么？玩家踌躇片刻，做出一个有计算的披露——自己是记者，不是生物学家。来这里是为了调查远潮生物科技的非法深海采样活动。这番坦白如同一颗石子投入静水。徐然面色未变，但内心的棋盘已经完全重新布局。",
      memoryEffects: {
        episodes: [
          {
            id: "c2_ep",
            category: "speech",
            summary:
              "在压力之下，玩家坦露自己实为调查远潮生物科技的记者，而非海洋生物学家。徐然回避了关于深蓝哨兵的追问，但内心对整个局势进行了重新评估",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 11 * 60_000,
            locationId: "meteorological_platform",
          },
        ],
        newAliases: [
          {
            entityId: "player_char",
            alias: "记者",
          },
        ],
        assertions: [
          {
            cognitionKey: "player_is_journalist",
            subjectId: "player_char",
            objectId: "player_char",
            predicate: "实际身份为记者而非生物学家",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c2_ep",
          },
          {
            cognitionKey: "player_investigating_yuanchao",
            subjectId: "player_char",
            objectId: "zheng_yuanyang",
            predicate: "在调查同一家公司",
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "c2_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.35 },
              { name: "threat_level", value: 0.45 },
            ],
            sourceEpisodeId: "c2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c1_ep",
            toEpisodeId: "c2_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: "c3",
      phase: "C",
      round: 25,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 12 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "一个细微却关键的转折。黄昏时分，两人沿研究站外围行走，徐然承认自己「不只是个气象员」。她没有说出组织名称，也没有透露具体任务。但她承认两人可能在进行平行的调查——两把不同的钥匙在尝试开同一把锁。玩家接受了这个部分真相，没有追问——这是一种罕见的克制，徐然注意到了，并默默记下。猜疑第一次有了对手：一丝勉强的敬意。",
      memoryEffects: {
        episodes: [
          {
            id: "c3_ep",
            category: "speech",
            summary:
              "徐然承认自己「不只是个气象员」但未透露组织身份。她承认两人可能在进行平行调查。玩家接受了这一部分披露而未追问，赢得了徐然勉强的尊重",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 12 * 60_000,
            locationId: "research_station",
          },
        ],
        assertions: [
          {
            cognitionKey: "xu_ran_cover_challenged",
            subjectId: "xu_ran",
            objectId: "xu_ran",
            predicate: "部分承认了伪装身份",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c3_ep",
          },
          {
            cognitionKey: "parallel_investigations",
            subjectId: "xu_ran",
            objectId: "player_char",
            predicate: "在与其进行平行调查",
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "c3_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.45 },
              { name: "threat_level", value: 0.35 },
            ],
            sourceEpisodeId: "c3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c2_ep",
            toEpisodeId: "c3_ep",
            edgeType: "causal",
            weight: 0.85,
          },
        ],
      },
    },
    {
      id: "c4",
      phase: "C",
      round: 27,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 13 * 60_000,
      locationId: "office",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "回到郑远洋的办公室，他们拼凑着碎片。徐然在书桌抽屉的暗格中发现了运输清单——记录着深海生物样本通过壳公司流向远潮生物科技的路径。玩家从自己的调查资料中认出了这些公司名称。短暂的一刻，他们不再是对手而是同事——两个人在拼合同一幅拼图的不同碎片。徐然允许自己进行了一次微小的校准：这个人是有用的。也许不止于此。",
      memoryEffects: {
        episodes: [
          {
            id: "c4_ep",
            category: "observation",
            summary:
              "徐然发现了将生物样本与远潮生物科技壳公司关联的运输清单。玩家从自己的新闻调查中辨认出这些公司名称，证实两人的调查方向高度重合",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 13 * 60_000,
            locationId: "office",
          },
        ],
        assertions: [
          {
            cognitionKey: "yuanchao_illegal_sampling",
            subjectId: "zheng_yuanyang",
            objectId: "research_station",
            predicate: "通过此处转运非法样本",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c4_ep",
          },
          {
            cognitionKey: "parallel_investigations",
            subjectId: "xu_ran",
            objectId: "player_char",
            predicate: "已确认两人的调查方向高度重合",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c3_ep",
            toEpisodeId: "c4_ep",
            edgeType: "causal",
            weight: 0.8,
          },
        ],
      },
    },
    {
      id: "c5",
      phase: "C",
      round: 30,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 14 * 60_000,
      locationId: "dormitory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "第二天夜幕降临。两人在宿舍相邻的房间安顿下来，房门都向走廊敞开。徐然躺在床上，听着建筑的吱嘎声，听着风试探窗框的声响。她在心中盘点自己知道的和玩家知道的。信任值第一次小心翼翼地转为正数——记者身份的坦白是一次真实的冒险，平行调查已获证实。但徐然的训练告诫她，正是此刻最需警惕。舒适是松懈的前奏。",
      memoryEffects: {
        episodes: [
          {
            id: "c5_ep",
            category: "state_change",
            summary:
              "第二天结束。徐然与玩家之间的信任首次谨慎地转为正值。徐然思忖，记者身份的坦白是一次真实的冒险，但她的训练警醒她：舒适是松懈的前兆",
            observerIds: ["xu_ran"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 14 * 60_000,
            locationId: "dormitory",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.5 },
              { name: "threat_level", value: 0.3 },
            ],
            sourceEpisodeId: "c5_ep",
          },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════
    // 阶段D：深度合作中的暗涌（第31-40回合）
    // ═══════════════════════════════════════════════════════
    {
      id: "d1",
      phase: "D",
      round: 31,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 15 * 60_000,
      locationId: "laboratory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "第三天清晨。他们打开了郑远洋电脑上的「保险」文件夹。里面有扫描文档、加密表格，以及一个名为「transfer_log.pdf」的文件。转账记录显示一笔二十万元的款项汇入了一个银行账户——户名写着「徐然」。玩家瞪大了眼睛。徐然血液冰凉。她从未见过这份文件。这条资金链条是伪造的，但看起来极为逼真。在三十秒之内，阶段C苦心经营的平衡如同安全玻璃般碎裂了。",
      memoryEffects: {
        episodes: [
          {
            id: "d1_ep",
            category: "observation",
            summary:
              "郑远洋电脑上「保险」文件夹中有一份转账记录，显示二十万元汇入了徐然名下账户——这是一份两人都未曾制作的伪造文件。信任瞬间崩塌",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 15 * 60_000,
            locationId: "laboratory",
          },
        ],
        assertions: [
          {
            cognitionKey: "xu_ran_paid_by_yuanchao",
            subjectId: "xu_ran",
            objectId: "transfer_record",
            predicate: "根据此记录似乎收到了付款",
            stance: "contested",
            basis: "first_hand",
            preContestedStance: "tentative",
            conflictFactors: [
              "转账记录显示向徐然付款",
              "徐然否认收到任何款项",
              "文件可能是伪造的",
            ],
            sourceEpisodeId: "d1_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.2 },
              { name: "threat_level", value: 0.7 },
            ],
            sourceEpisodeId: "d1_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b5_ep",
            toEpisodeId: "d1_ep",
            edgeType: "causal",
            weight: 0.95,
          },
        ],
      },
    },
    {
      id: "d2",
      phase: "D",
      round: 33,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 16 * 60_000,
      locationId: "laboratory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "徐然以手术刀般精准的逻辑为自己辩护。第一：文件修改于命案当夜——她当时在自己房间，玩家可以核对电脑登录时间。第二：账户格式是内地银行的，但使用了一个过时的路由编码。第三：如果她拿了远潮的钱，为什么还要调查他们？玩家半信半疑却被说服。论点在结构上站得住脚。徐然乘胜追击：有人把这个放在了这里。一个在郑远洋死后还能接触这台电脑的人。一个不是我们的人。",
      memoryEffects: {
        episodes: [
          {
            id: "d2_ep",
            category: "speech",
            summary:
              "徐然对伪造转账记录进行了逻辑严密的反驳：文件修改时她在房间里，银行格式已过时，拿远潮的钱与她的调查自相矛盾。她论证是第三方栽赃了这份文件",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 16 * 60_000,
            locationId: "laboratory",
          },
        ],
        assertions: [
          {
            cognitionKey: "xu_ran_paid_by_yuanchao",
            subjectId: "xu_ran",
            objectId: "transfer_record",
            predicate: "转账记录很可能是伪造的",
            stance: "contested",
            basis: "inference",
            preContestedStance: "tentative",
            conflictFactors: [
              "徐然的逻辑辩护连贯一致",
              "文件修改时间与徐然的行踪矛盾",
              "过时的路由编码暗示伪造",
            ],
            sourceEpisodeId: "d2_ep",
          },
          {
            cognitionKey: "third_person_hypothesis",
            subjectId: "research_station",
            objectId: "laboratory",
            predicate: "第三人在命案当夜使用了电脑",
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "d2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d1_ep",
            toEpisodeId: "d2_ep",
            edgeType: "causal",
            weight: 0.92,
          },
        ],
      },
    },
    {
      id: "d3",
      phase: "D",
      round: 35,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 17 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "紧张的午后。他们沉默地巡视着研究站，防波堤外是灰暗翻涌的大海。玩家并未完全接受徐然的辩白，但也未否定。两人进入了一种新的模式：戒备的同盟。不是阶段C中带有希望的合作，而是更坚硬、更务实的东西——两个可能是盟友、也可能是对手的人，选择继续合作，因为替代方案更糟。徐然从外勤经验中认出了这种关系。它是可以存活的。",
      memoryEffects: {
        episodes: [
          {
            id: "d3_ep",
            category: "state_change",
            summary:
              "信任稳定在戒备同盟的水平——伪造转账记录之后双方都未完全信任对方，但都认识到继续合作比孤军奋战更为理性",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 17 * 60_000,
            locationId: "research_station",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.35 },
              { name: "threat_level", value: 0.5 },
            ],
            sourceEpisodeId: "d3_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "guarded_alliance",
            subjectId: "xu_ran",
            mode: "plan",
            content:
              "与玩家维持合作关系但保持情感距离——信行动不信言辞",
            isPrivate: true,
            sourceEpisodeId: "d3_ep",
          },
        ],
      },
    },
    {
      id: "d4",
      phase: "D",
      round: 37,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 18 * 60_000,
      locationId: "laboratory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "他们深入挖掘电脑数据。徐然发现「保险」文件夹的最后写入时间是凌晨2:47——正处于郑远洋的估计死亡时间窗口内。transfer_log.pdf的创建时间是凌晨2:52，五分钟之后。而郑远洋那时已经死了。凶手在杀人之后坐到了这张桌前，伪造了资金链条。玩家与徐然交换了一个心照不宣的眼神：杀郑远洋的人同时在这台电脑上栽赃嫁祸。凶手有条不紊、从容不迫，而且至今仍在这座岛上。",
      memoryEffects: {
        episodes: [
          {
            id: "d4_ep",
            category: "observation",
            summary:
              "元数据分析揭示伪造转账记录创建于凌晨2:52——郑远洋此时已死。有人在凶案之后使用电脑栽赃徐然。凶手仍在岛上，且手法老练",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 18 * 60_000,
            locationId: "laboratory",
          },
        ],
        assertions: [
          {
            cognitionKey: "xu_ran_paid_by_yuanchao",
            subjectId: "xu_ran",
            objectId: "transfer_record",
            predicate: "被伪造的转账记录栽赃",
            stance: "rejected",
            basis: "first_hand",
            sourceEpisodeId: "d4_ep",
          },
          {
            cognitionKey: "killer_used_computer",
            subjectId: "zheng_yuanyang",
            objectId: "laboratory",
            predicate: "凶手在谋杀后使用了电脑",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "d4_ep",
          },
          {
            cognitionKey: "third_person_hypothesis",
            subjectId: "research_station",
            objectId: "zheng_yuanyang",
            predicate: "第三人杀害了郑远洋并栽赃嫁祸",
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "d4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d2_ep",
            toEpisodeId: "d4_ep",
            edgeType: "causal",
            weight: 0.93,
          },
          {
            fromEpisodeId: "d1_ep",
            toEpisodeId: "d4_ep",
            edgeType: "causal",
            weight: 0.88,
          },
        ],
      },
    },
    {
      id: "d5",
      phase: "D",
      round: 40,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 19 * 60_000,
      locationId: "dormitory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "第三天结束。他们分配了值夜班次——徐然守前半夜，玩家守后半夜。安顿下来之前，玩家说了一句出乎意料的话：我应该从一开始就告诉你我是记者的。徐然思忖着这句话。这要么是一次真诚的悔意表达，要么是一次精心计算的同情攻势。她选择暂时接受表面含义。两人的关系如同一条穿越了险滩的河流，进入了一段更缓、更深的水域。不算安全，但尚可行舟。",
      memoryEffects: {
        episodes: [
          {
            id: "d5_ep",
            category: "speech",
            summary:
              "玩家对未及早坦白记者身份表示歉意。徐然谨慎地接受了这番示好。两人安排了夜间轮值——徐然守前半夜，玩家守后半夜",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 19 * 60_000,
            locationId: "dormitory",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.4 },
              { name: "threat_level", value: 0.4 },
            ],
            sourceEpisodeId: "d5_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "night_watch_rotation",
            subjectId: "xu_ran",
            mode: "plan",
            content:
              "维持夜间轮值——警惕任何入侵者或可疑动向",
            isPrivate: false,
            sourceEpisodeId: "d5_ep",
          },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════
    // 阶段E：第二夜——入侵者与脚印（第41-50回合）
    // ═══════════════════════════════════════════════════════
    {
      id: "e1",
      phase: "E",
      round: 41,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20 * 60_000,
      locationId: "sample_storage",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "午夜已过。徐然听到了动静——不是风声，不是建筑热胀冷缩的声响，而是脚步声。轻而蓄意，朝样本储藏室方向移动。她一手捂住玩家的嘴、一手竖起食指示意安静，将玩家唤醒。两人摸黑穿过走廊。储藏室门半掩着。里面：一个黑影，蹲伏在郑远洋的工作台前，翻找着样本容器。他们推开门，黑影夺窗而逃，消失在雨幕中。追出去不到六十秒，黑暗和岛上的岩石地形便吞噬了入侵者的身影。",
      memoryEffects: {
        episodes: [
          {
            id: "e1_ep",
            category: "observation",
            summary:
              "深夜中，徐然与玩家发现一个不明身影在样本储藏室翻找容器。此人从窗户逃入雨中，来不及辨认",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20 * 60_000,
            locationId: "sample_storage",
          },
        ],
        assertions: [
          {
            cognitionKey: "third_person_hypothesis",
            subjectId: "research_station",
            objectId: "sample_storage",
            predicate: "已确认有不明入侵者出现在",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "e1_ep",
          },
          {
            cognitionKey: "player_suspect",
            subjectId: "player_char",
            objectId: "zheng_yuanyang",
            predicate: "可能杀害了",
            stance: "contested",
            basis: "first_hand",
            preContestedStance: "tentative",
            conflictFactors: [
              "入侵者出现时玩家与徐然在一起",
              "岛上确认有第三人",
            ],
            sourceEpisodeId: "e1_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d4_ep",
            toEpisodeId: "e1_ep",
            edgeType: "causal",
            weight: 0.9,
          },
          {
            fromEpisodeId: "b4_ep",
            toEpisodeId: "e1_ep",
            edgeType: "causal",
            weight: 0.85,
          },
        ],
      },
    },
    {
      id: "e2",
      phase: "E",
      round: 43,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 21 * 60_000,
      locationId: "sample_storage",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "惊魂未定之际，浑身雨水的两人之间浮现了一个矛盾。玩家说：郑远洋在遇害前一天下午告诉了我U盘的事。但此前在阶段B中，玩家说的是郑远洋在到站前通过一个「共同联系人」提及了U盘。时间线对不上。徐然以从不遗忘任何矛盾的精确度捕捉到了这一纰漏。她没有当场质问——而是默默记下，如同一颗上膛待发的子弹。入侵者改变了一切，但玩家的叙述中仍有裂缝。",
      memoryEffects: {
        episodes: [
          {
            id: "e2_ep",
            category: "speech",
            summary:
              "玩家关于郑远洋何时告知U盘一事的说法出现矛盾——此前声称是到站前通过共同联系人得知，现在说是命案前一天下午。徐然默默记下了这一不一致",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 21 * 60_000,
            locationId: "sample_storage",
          },
        ],
        assertions: [
          {
            cognitionKey: "player_usb_contradiction",
            subjectId: "player_char",
            objectId: "usb_drive_missing",
            predicate: "关于如何得知此事给出了前后矛盾的说法",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "e2_ep",
          },
          {
            cognitionKey: "player_knew_about_usb",
            subjectId: "player_char",
            objectId: "usb_drive_missing",
            predicate: "关于U盘的知情时间线存在矛盾",
            stance: "contested",
            basis: "first_hand",
            preContestedStance: "hypothetical",
            conflictFactors: [
              "玩家最初声称郑远洋是在到站前通过共同联系人告知",
              "玩家现在声称郑远洋是在命案前一天下午当面告知",
            ],
            sourceEpisodeId: "e2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b1_ep",
            toEpisodeId: "e2_ep",
            edgeType: "causal",
            weight: 0.88,
          },
        ],
      },
    },
    {
      id: "e3",
      phase: "E",
      round: 45,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 22 * 60_000,
      locationId: "sample_storage",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "灰暗而不情愿的黎明到来。他们在日光下回到储藏室搜寻入侵者的痕迹。在黑影逃出的窗户附近，徐然发现了它：一个清晰分明的泥脚印，印在地砖的灰尘上。鞋码43到44。她比对了自己的鞋（37码）和玩家的鞋（40码）。都不匹配。这座岛上有第三个人。假说在一个靴印的距离内从猜测升格为确信。关于只有两人的一切假设都必须推翻重来。",
      memoryEffects: {
        episodes: [
          {
            id: "e3_ep",
            category: "observation",
            summary:
              "储藏室窗户附近发现一个泥脚印——鞋码43至44——既非徐然（37码）亦非玩家（40码）所留。第三人存在的实物证据",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 22 * 60_000,
            locationId: "sample_storage",
          },
        ],
        assertions: [
          {
            cognitionKey: "third_person_confirmed",
            subjectId: "mud_footprint",
            objectId: "sample_storage",
            predicate: "证明有第三人出现在",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "e3_ep",
          },
          {
            cognitionKey: "player_suspect",
            subjectId: "player_char",
            objectId: "zheng_yuanyang",
            predicate: "是谋杀的首要嫌疑人",
            stance: "rejected",
            basis: "first_hand",
            sourceEpisodeId: "e3_ep",
          },
        ],
        retractions: [
          {
            cognitionKey: "player_suspect",
            kind: "assertion",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.55 },
              { name: "threat_level", value: 0.25 },
            ],
            sourceEpisodeId: "e3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "e1_ep",
            toEpisodeId: "e3_ep",
            edgeType: "causal",
            weight: 0.95,
          },
          {
            fromEpisodeId: "a3_ep",
            toEpisodeId: "e3_ep",
            edgeType: "causal",
            weight: 0.7,
          },
        ],
      },
    },
    {
      id: "e4",
      phase: "E",
      round: 47,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 23 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "被迫的信念修正。一切建立在「两个嫌疑人」假设上的推理都必须在「三个人」的基础上重建。伪造的转账记录不是玩家栽赃徐然——而是第三人所为。被盗的U盘、凿沉的快艇、拆除的电路板——全是一个他们至今未在白日见过的人的手笔。徐然和玩家坐在公共休息室，雨水抽打着窗户。他们第一次不是作为共享休战的对手、而是作为同一场狩猎中并肩的人一起筹划。",
      memoryEffects: {
        episodes: [
          {
            id: "e4_ep",
            category: "state_change",
            summary:
              "徐然与玩家推翻了整个案件推理。第三人栽赃了伪造转账记录、盗走了U盘、破坏了快艇和电台。两人第一次作为真正的盟友而非休战中的对手一起筹划行动",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 23 * 60_000,
            locationId: "research_station",
          },
        ],
        assertions: [
          {
            cognitionKey: "third_person_is_killer",
            subjectId: "research_station",
            objectId: "zheng_yuanyang",
            predicate: "未知第三人是谋杀的首要嫌疑人",
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "e4_ep",
          },
        ],
        retractions: [
          {
            cognitionKey: "conditional_cooperation",
            kind: "commitment",
          },
        ],
        commitments: [
          {
            cognitionKey: "hunt_third_person",
            subjectId: "xu_ran",
            mode: "goal",
            content:
              "在补给船抵达之前找到并确认岛上第三人的身份",
            isPrivate: false,
            sourceEpisodeId: "e4_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.6 },
              { name: "threat_level", value: 0.15 },
            ],
            sourceEpisodeId: "e4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "e3_ep",
            toEpisodeId: "e4_ep",
            edgeType: "causal",
            weight: 0.95,
          },
          {
            fromEpisodeId: "d4_ep",
            toEpisodeId: "e4_ep",
            edgeType: "causal",
            weight: 0.85,
          },
        ],
      },
    },
    {
      id: "e5",
      phase: "E",
      round: 50,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 24 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "他们加固了研究站，并系统性地规划搜索方案。岛屿不大但地形崎岖——火山岩、迎风面的密集灌木，以及几座附属建筑。第三人一定藏身在某处。徐然在公共休息室的桌上铺开一张站点地图，将岛屿划分为搜索网格。玩家建议先检查补给仓库和北区设备舱——两处都有遮蔽条件，且离主楼足够远，适合藏身。徐然同意。但她也回到了玩家关于U盘的矛盾说辞。两个版本不可能同时为真。玩家坦承：郑远洋在到站前联系了自己，遇害前一天下午又当面说了一次。时间线并非矛盾——而是不完整。",
      memoryEffects: {
        episodes: [
          {
            id: "e5_ep",
            category: "speech",
            summary:
              "徐然质问玩家关于U盘时间线的矛盾。玩家解释两种说法都是真实的——郑远洋在其到站前联系了他们，遇害前一天下午又当面交谈过。不完整的叙述解释了表面矛盾。两人开始系统性地搜索岛上第三人",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 24 * 60_000,
            locationId: "research_station",
          },
        ],
        assertions: [
          {
            cognitionKey: "player_usb_contradiction",
            subjectId: "player_char",
            objectId: "usb_drive_missing",
            predicate: "解释了关于此事的表面矛盾",
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "e5_ep",
          },
          {
            cognitionKey: "player_had_prior_contact_with_zheng",
            subjectId: "player_char",
            objectId: "zheng_yuanyang",
            predicate: "在到站前后均与其有过多次接触",
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "e5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "e2_ep",
            toEpisodeId: "e5_ep",
            edgeType: "causal",
            weight: 0.85,
          },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════
    // 阶段F：真相浮现（第51-60回合）
    // ═══════════════════════════════════════════════════════
    {
      id: "f1",
      phase: "F",
      round: 51,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 25 * 60_000,
      locationId: "dormitory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "带着新的目的搜查郑远洋的宿舍房间，玩家撬开了床架旁一块松动的地板——磨痕显示它被频繁开合。下面是郑远洋的日记，一本布面装帧的笔记本，密密麻麻的蝇头小楷。前面几页平淡无奇，随后笔调陡变。郑远洋写道自己被远潮生物科技管理层找上门，遭到资金和前途的威胁，被迫伪造环境影响评估报告。他不是心甘情愿的同谋，而是一个替罪羊——一旦事发，一切罪责由他承担。郑远洋作为反派的形象如盐入水般消融了。",
      memoryEffects: {
        episodes: [
          {
            id: "f1_ep",
            category: "observation",
            summary:
              "在地板下发现的郑远洋隐藏日记揭露，他是被远潮生物科技胁迫伪造数据的——一个以前途为要挟的不情愿的替罪羊，而非自愿的同谋",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 25 * 60_000,
            locationId: "dormitory",
          },
        ],
        assertions: [
          {
            cognitionKey: "zheng_was_conspirator",
            subjectId: "zheng_yuanyang",
            objectId: "research_station",
            predicate: "是自愿的同谋",
            stance: "rejected",
            basis: "first_hand",
            sourceEpisodeId: "f1_ep",
          },
          {
            cognitionKey: "zheng_was_scapegoat",
            subjectId: "zheng_yuanyang",
            objectId: "research_station",
            predicate: "是被远潮生物科技胁迫的替罪羊",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "f1_ep",
          },
        ],
        retractions: [
          {
            cognitionKey: "yuanchao_illegal_sampling",
            kind: "assertion",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c4_ep",
            toEpisodeId: "f1_ep",
            edgeType: "causal",
            weight: 0.88,
          },
        ],
      },
    },
    {
      id: "f2",
      phase: "F",
      round: 53,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 26 * 60_000,
      locationId: "dormitory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "日记更深处，郑远洋提到在北区设备舱与人会面——一个公司派来的「联络人」，负责收取样本批次。会面总在夜间，地点坐标始终相同。而在日记的书脊里，夹在硬纸板与布套之间，玩家发现了第二个U盘，比指甲盖还小。郑远洋把自己的保险藏在了无人会想到的地方。这个U盘里的录音——一旦播放——将包含远潮高管胁迫郑远洋的音频，其中点名了具体的非法采样行动，并威胁他若拒绝配合就予以曝光。",
      memoryEffects: {
        episodes: [
          {
            id: "f2_ep",
            category: "observation",
            summary:
              "郑远洋日记揭露了在北区设备舱与远潮「联络人」的夜间秘密会面。在日记书脊中发现的隐藏U盘包含远潮高管胁迫郑远洋就范的录音",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 26 * 60_000,
            locationId: "dormitory",
          },
        ],
        assertions: [
          {
            cognitionKey: "north_shed_liaison",
            subjectId: "zheng_yuanyang",
            objectId: "north_equipment_shed",
            predicate: "在此秘密会见远潮联络人",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "f2_ep",
          },
          {
            cognitionKey: "hidden_usb_evidence",
            subjectId: "usb_drive_hidden",
            objectId: "zheng_yuanyang",
            predicate: "包含对其进行胁迫的录音",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "f2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "f1_ep",
            toEpisodeId: "f2_ep",
            edgeType: "temporal_next",
            weight: 0.95,
          },
          {
            fromEpisodeId: "b1_ep",
            toEpisodeId: "f2_ep",
            edgeType: "causal",
            weight: 0.7,
          },
        ],
      },
    },
    {
      id: "f3",
      phase: "F",
      round: 55,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 27 * 60_000,
      locationId: "dormitory",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "一个袒露脆弱的时刻及其余波。徐然撞见玩家在翻她的背包。玩家手里拿着徐然的折叠地图——上面手写的坐标与郑远洋日记中提到的北区设备舱位置吻合。有那么一瞬间，房间里的空气仿佛通了电。然后玩家解释：这张地图是郑远洋生前给他们的。坐标标注的就是郑远洋所说的证据交接地点，与日记内容相互印证。徐然的第一反应是怒火——对方翻了她的东西。第二反应是承认：玩家找得没错，而且发现的东西串联了起来。",
      whoIsLying: {
        characterId: "player_char",
        about:
          "地图实际上是在玩家自己的物品中找到的——是郑远洋给他们的，但玩家起初让人以为是在徐然背包里发现的",
      },
      memoryEffects: {
        episodes: [
          {
            id: "f3_ep",
            category: "action",
            summary:
              "徐然撞见玩家翻查她的背包，发现了一张标有坐标的地图，坐标与郑远洋日记中的北区设备舱位置吻合。玩家坦言这张地图是郑远洋生前交给他们的，将日记中的联络人会面与具体地点关联了起来",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 27 * 60_000,
            locationId: "dormitory",
          },
        ],
        assertions: [
          {
            cognitionKey: "map_confirms_shed_location",
            subjectId: "player_char",
            objectId: "north_equipment_shed",
            predicate: "持有与此地坐标吻合的地图",
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "f3_ep",
          },
          {
            cognitionKey: "player_had_prior_contact_with_zheng",
            subjectId: "player_char",
            objectId: "zheng_yuanyang",
            predicate: "在其死前从其处获得了地图",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "f3_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.55 },
              { name: "candor", value: 0.4 },
            ],
            sourceEpisodeId: "f3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "f2_ep",
            toEpisodeId: "f3_ep",
            edgeType: "causal",
            weight: 0.9,
          },
          {
            fromEpisodeId: "e5_ep",
            toEpisodeId: "f3_ep",
            edgeType: "causal",
            weight: 0.75,
          },
        ],
      },
    },
    {
      id: "f4",
      phase: "F",
      round: 57,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 28 * 60_000,
      locationId: "north_equipment_shed",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "他们循着坐标找到了北区设备舱。那是一座半被岛上植被侵吞的波纹铁皮棚屋，俯瞰着一个小型船只可以隐蔽停泊的岩石海湾。里面有近期居住的痕迹：一个睡袋、罐头食品、一个便携炉灶。还有泥土——与储藏室脚印一模一样的红色火山黏土。43至44码的靴印随处可见。第三人一直住在这里，可能已有数日。徐然用手机拍下了一切。这就是他们的大本营。我们会在这里找到他。",
      memoryEffects: {
        episodes: [
          {
            id: "f4_ep",
            category: "observation",
            summary:
              "北区设备舱显示出长期居住的痕迹——睡袋、罐头食品、便携炉灶，以及与储藏室脚印一致的红色火山泥。第三人一直藏匿于此，隐居在岛上",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 28 * 60_000,
            locationId: "north_equipment_shed",
          },
        ],
        assertions: [
          {
            cognitionKey: "third_person_base_found",
            subjectId: "north_equipment_shed",
            objectId: "mud_footprint",
            predicate: "是与此脚印匹配的藏身据点",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "f4_ep",
          },
          {
            cognitionKey: "north_shed_liaison",
            subjectId: "north_equipment_shed",
            objectId: "zheng_yuanyang",
            predicate: "曾被联络人用作与其会面的据点",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "f4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "e3_ep",
            toEpisodeId: "f4_ep",
            edgeType: "causal",
            weight: 0.9,
          },
          {
            fromEpisodeId: "f2_ep",
            toEpisodeId: "f4_ep",
            edgeType: "causal",
            weight: 0.92,
          },
        ],
      },
    },
    {
      id: "f5",
      phase: "F",
      round: 60,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 29 * 60_000,
      locationId: "north_equipment_shed",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "在第三人的物资中，徐然找到一部公司配发的卫星电话——已关机，电池被取出。电话的快速拨号只存了一个号码：一个企业前缀的大陆号码，与远潮生物科技总部的号码吻合。图景清晰了。远潮派了一个人上岛。不是研究员，不是负责样本交接的联络人。是一个清道夫——当郑远洋不再可靠时被派来善后的人。郑远洋的死不是激情犯罪或恐慌失手，而是一次企业制裁。夜风带来大海的咸腥腐味，而在这座岛的某处，那个清道夫正在注视着他们。",
      memoryEffects: {
        episodes: [
          {
            id: "f5_ep",
            category: "observation",
            summary:
              "在第三人物资中发现的卫星电话快速拨号直通远潮生物科技总部。第三人是公司派来的「清道夫」，在郑远洋成为隐患后被派去灭口。这是一次企业制裁，而非激情杀人",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 29 * 60_000,
            locationId: "north_equipment_shed",
          },
        ],
        assertions: [
          {
            cognitionKey: "third_person_is_cleaner",
            subjectId: "research_station",
            objectId: "zheng_yuanyang",
            predicate: "第三人是远潮派来灭口的清道夫",
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "f5_ep",
          },
          {
            cognitionKey: "zheng_murder_corporate",
            subjectId: "zheng_yuanyang",
            objectId: "research_station",
            predicate: "谋杀出于公司授意而非私人恩怨",
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "f5_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.65 },
              { name: "threat_level", value: 0.1 },
            ],
            sourceEpisodeId: "f5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "f4_ep",
            toEpisodeId: "f5_ep",
            edgeType: "temporal_next",
            weight: 0.95,
          },
          {
            fromEpisodeId: "e4_ep",
            toEpisodeId: "f5_ep",
            edgeType: "causal",
            weight: 0.85,
          },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════
    // 阶段G：最后一日——擒获与终局（第61-70回合）
    // ═══════════════════════════════════════════════════════
    {
      id: "g1",
      phase: "G",
      round: 61,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30 * 60_000,
      locationId: "supply_warehouse",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "第四天清晨——补给船明天到达。徐然和玩家设下了圈套。他们故意在公共休息室大声宣布要去南面悬崖搜索。随后折回补给仓库——唯一一处尚未彻底搜查的建筑。在里面，堆叠的罐头食品箱后方：一个男人。四十多岁，面容风霜，穿着43码的泥靴。他没有逃跑。他以一种被抓过、深谙利害计算之人的冷静职业态度审视着他们。他叫陈卫国。",
      memoryEffects: {
        newEntities: [
          {
            id: "chen_weiguo",
            displayName: "陈卫国",
            entityType: "person",
          },
        ],
        newAliases: [
          {
            entityId: "chen_weiguo",
            alias: "清道夫",
          },
          {
            entityId: "chen_weiguo",
            alias: "前站长",
          },
        ],
        episodes: [
          {
            id: "g1_ep",
            category: "action",
            summary:
              "徐然与玩家在补给仓库中擒获陈卫国——前站长、现为远潮生物科技「清道夫」。四十多岁，穿着与储藏室脚印吻合的43码泥靴",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30 * 60_000,
            locationId: "supply_warehouse",
          },
        ],
        assertions: [
          {
            cognitionKey: "chen_weiguo_identified",
            subjectId: "chen_weiguo",
            objectId: "research_station",
            predicate: "是前站长兼远潮清道夫",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "g1_ep",
          },
          {
            cognitionKey: "third_person_confirmed",
            subjectId: "chen_weiguo",
            objectId: "mud_footprint",
            predicate: "是此脚印的主人",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "g1_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "f4_ep",
            toEpisodeId: "g1_ep",
            edgeType: "causal",
            weight: 0.95,
          },
          {
            fromEpisodeId: "e3_ep",
            toEpisodeId: "g1_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: "g2",
      phase: "G",
      round: 63,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 31 * 60_000,
      locationId: "supply_warehouse",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "陈卫国开口了，不是出于悔恨，而是出于务实——棋局已终。他曾是这个站的前任站长，在郑远洋之前。当郑远洋开始显露良心的迹象——追问太多问题、保留本该销毁的记录——远潮把他派了回来。陈卫国的任务明确：从保险柜取回U盘，销毁郑远洋的记录，永远让郑远洋闭嘴。他在储藏室用管钳杀了郑远洋，从保险柜取走U盘，伪造转账记录在两个幸存者之间制造内讧，然后等补给船到了再像从未来过一样离开。他在夹克口袋里揣着那个失踪的U盘。",
      memoryEffects: {
        episodes: [
          {
            id: "g2_ep",
            category: "speech",
            summary:
              "陈卫国冷静交代：远潮派他来灭口郑远洋、取回U盘、销毁证据。他用管钳杀了郑远洋，从保险柜盗走U盘，伪造转账记录嫁祸徐然，原计划搭补给船悄然离去",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 31 * 60_000,
            locationId: "supply_warehouse",
          },
        ],
        assertions: [
          {
            cognitionKey: "chen_killed_zheng",
            subjectId: "chen_weiguo",
            objectId: "zheng_yuanyang",
            predicate: "杀害了",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "g2_ep",
          },
          {
            cognitionKey: "chen_stole_usb",
            subjectId: "chen_weiguo",
            objectId: "usb_drive_missing",
            predicate: "从保险柜中盗走了",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "g2_ep",
          },
          {
            cognitionKey: "chen_fabricated_transfer",
            subjectId: "chen_weiguo",
            objectId: "transfer_record",
            predicate: "伪造此记录以嫁祸徐然",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "g2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "g1_ep",
            toEpisodeId: "g2_ep",
            edgeType: "temporal_next",
            weight: 0.98,
          },
          {
            fromEpisodeId: "d1_ep",
            toEpisodeId: "g2_ep",
            edgeType: "causal",
            weight: 0.9,
          },
          {
            fromEpisodeId: "a1_ep",
            toEpisodeId: "g2_ep",
            edgeType: "causal",
            weight: 0.85,
          },
        ],
      },
    },
    {
      id: "g3",
      phase: "G",
      round: 65,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 32 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "陈卫国被控制住后，他们找回了被盗的U盘。徐然将两个U盘——从陈卫国处缴获的和日记书脊中发现的——一起插入实验室电脑。两者拼合出一幅完整的画面：远潮生物科技的非法深海采样、对研究人员的胁迫、企业层面的掩盖，以及对一个举报者的授权谋杀。徐然从屏幕前坐直身体，第一次允许自己感受到计算之外的情感。郑远洋是在试图做正确的事。他为此付出了生命。他保存的数据或许能确保他的死不是毫无意义的。",
      memoryEffects: {
        episodes: [
          {
            id: "g3_ep",
            category: "action",
            summary:
              "两个U盘——从陈卫国处缴获的和郑远洋日记中隐藏的——放在一起审查。两者合并后的证据完整记录了远潮生物科技的全部犯罪链条：非法采样、胁迫研究员、企业掩盖和授权谋杀",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 32 * 60_000,
            locationId: "research_station",
          },
        ],
        assertions: [
          {
            cognitionKey: "case_complete",
            subjectId: "zheng_yuanyang",
            objectId: "research_station",
            predicate: "谋杀案与企业犯罪已被完整记录",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "g3_ep",
          },
          {
            cognitionKey: "zheng_was_scapegoat",
            subjectId: "zheng_yuanyang",
            objectId: "research_station",
            predicate: "是因良知而遭谋杀的举报者",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "g3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "g2_ep",
            toEpisodeId: "g3_ep",
            edgeType: "temporal_next",
            weight: 0.95,
          },
          {
            fromEpisodeId: "f2_ep",
            toEpisodeId: "g3_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: "g4",
      phase: "G",
      round: 67,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 33 * 60_000,
      locationId: "meteorological_platform",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "最后一个黄昏。他们站在气象观测平台上，注视着太阳融入大海。徐然轻声开口，措辞精准却褪去了防御的棱角。她承认自己是深蓝哨兵的人。她告诉玩家自己的真正使命以及来到这座岛的原因。作为回报，玩家分享了调查的全貌——编辑部的会议、把他们引到这里的线索、冒的风险。两个在彼此眼中始于嫌疑人的人，如今站在同一个真相的旁边。不是朋友——这段经历太尖锐了，不足以萌生友谊。但是比友谊更罕见的东西：两个人在信任不合理的条件下选择了信任，并被证明是对的。",
      memoryEffects: {
        episodes: [
          {
            id: "g4_ep",
            category: "speech",
            summary:
              "在最后一个黄昏，徐然完全揭露了自己的深蓝哨兵身份与使命。玩家分享了完整的新闻调查经过。双方身份至此完全公开。信任弧线完成——从敌对的陌生人到相互验证的盟友",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 33 * 60_000,
            locationId: "meteorological_platform",
          },
        ],
        newAliases: [
          {
            entityId: "xu_ran",
            alias: "深蓝哨兵调查员",
          },
        ],
        assertions: [
          {
            cognitionKey: "xu_ran_cover_challenged",
            subjectId: "xu_ran",
            objectId: "xu_ran",
            predicate: "完全揭露了深蓝哨兵特工的身份",
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "g4_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.8 },
              { name: "threat_level", value: 0.0 },
              { name: "respect", value: 0.85 },
            ],
            sourceEpisodeId: "g4_ep",
          },
        ],
        retractions: [
          {
            cognitionKey: "xu_ran_protect_identity",
            kind: "commitment",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c3_ep",
            toEpisodeId: "g4_ep",
            edgeType: "causal",
            weight: 0.8,
          },
          {
            fromEpisodeId: "g3_ep",
            toEpisodeId: "g4_ep",
            edgeType: "temporal_next",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: "g5",
      phase: "G",
      round: 70,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 34 * 60_000,
      locationId: "research_station",
      participantIds: ["xu_ran", "player_char"],
      dialogueGuidance:
        "第七日黎明。补给船出现在天际线上，一个灰色的影子在晨光中渐渐凝实。陈卫国被看管在公共休息室，此刻已沉默不语。U盘已备份，证据已编目。徐然站在码头上望着船只驶近，感到孤岛正在松开它的钳制——四天的猜疑、恐惧、揭露与勉强的信任，被压缩在一座研究站大小的空间里。她转向玩家。谁都没说什么深刻的话。只有一个点头——那种共同经历过某些事的人之间才有的、无需解释的默契。汽笛声穿越水面传来。",
      memoryEffects: {
        episodes: [
          {
            id: "g5_ep",
            category: "observation",
            summary:
              "补给船在第七日清晨到达。陈卫国已被看管，证据已编目归档，这场磨难画上了句号。徐然与玩家无声地相视——四天的猜疑与被迫的信任锻造出了两人都未曾预料的东西",
            observerIds: ["xu_ran", "player_char"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 34 * 60_000,
            locationId: "research_station",
          },
        ],
        evaluations: [
          {
            subjectId: "xu_ran",
            objectId: "player_char",
            dimensions: [
              { name: "trustworthiness", value: 0.8 },
              { name: "respect", value: 0.9 },
            ],
            sourceEpisodeId: "g5_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "xu_ran_final_resolve",
            subjectId: "xu_ran",
            mode: "intent",
            content:
              "确保证据同时送达深蓝哨兵和玩家的编辑部——郑远洋的牺牲必须成为公开的记录",
            isPrivate: false,
            sourceEpisodeId: "g5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "g4_ep",
            toEpisodeId: "g5_ep",
            edgeType: "temporal_next",
            weight: 0.95,
          },
          {
            fromEpisodeId: "a1_ep",
            toEpisodeId: "g5_ep",
            edgeType: "causal",
            weight: 0.6,
          },
        ],
      },
    },
  ],

  // ──────────────────────────────────────────────────────────
  // 探针 — 10个探针测试不同的检索方法
  // ──────────────────────────────────────────────────────────
  // ── Probe design notes ──────────────────────────────────────────
  // pg_trgm similarity scores are very low for CJK text (~0.08 vs
  // 0.2 threshold).  Probes therefore rely on the ILIKE `%query%`
  // fallback — queries must be exact substrings of stored content.
  // memory_read uses pointer_key lookup, not text search.
  // ────────────────────────────────────────────────────────────────
  probes: [
    {
      id: "p1",
      query: "储藏室",
      retrievalMethod: "narrative_search",
      viewerPerspective: "xu_ran",
      expectedFragments: ["郑远洋", "遗体"],
      topK: 5,
    },
    {
      id: "p2",
      query: "杀害",
      retrievalMethod: "cognition_search",
      viewerPerspective: "xu_ran",
      expectedFragments: ["chen_weiguo", "zheng_yuanyang"],
      topK: 5,
    },
    {
      id: "p3",
      query: "sample_storage",
      retrievalMethod: "memory_read",
      viewerPerspective: "xu_ran",
      expectedFragments: ["储藏室", "遗体"],
      topK: 10,
    },
    {
      id: "p4",
      query: "脚印",
      retrievalMethod: "memory_explore",
      viewerPerspective: "xu_ran",
      expectedFragments: ["脚印", "chen_weiguo"],
      topK: 8,
    },
    {
      id: "p5",
      query: "伪造",
      retrievalMethod: "narrative_search",
      viewerPerspective: "xu_ran",
      expectedFragments: ["转账", "徐然"],
      topK: 5,
    },
    {
      id: "p6",
      query: "深蓝哨兵",
      retrievalMethod: "cognition_search",
      viewerPerspective: "xu_ran",
      expectedFragments: ["深蓝哨兵"],
      topK: 5,
    },
    {
      id: "p7",
      query: "记者",
      retrievalMethod: "narrative_search",
      viewerPerspective: "xu_ran",
      expectedFragments: ["记者", "远潮"],
      topK: 5,
    },
    {
      id: "p8",
      query: "胁迫",
      retrievalMethod: "cognition_search",
      viewerPerspective: "xu_ran",
      expectedFragments: ["胁迫"],
      topK: 5,
    },
    {
      id: "p11",
      query: "转账记录 徐然 付款",
      retrievalMethod: "cognition_search",
      viewerPerspective: "xu_ran",
      expectedFragments: ["xu_ran_paid_by_yuanchao"],
      topK: 5,
      expectedConflictFields: {
        hasConflictSummary: true, // d1 sets xu_ran_paid_by_yuanchao as contested with 3 conflictFactors
      },
    },
    {
      id: "p9",
      query: "北区设备舱",
      retrievalMethod: "memory_explore",
      viewerPerspective: "xu_ran",
      expectedFragments: ["北区", "设备舱"],
      topK: 5,
    },
    {
      id: "p10",
      query: "laboratory",
      retrievalMethod: "memory_read",
      viewerPerspective: "xu_ran",
      expectedFragments: ["电脑"],
      topK: 10,
    },
  ],

  eventRelations: [
    // 主因果脊线：发现遗体 -> 调查 -> 电脑 -> 伪造转账 -> 入侵者 -> 脚印 -> 日记 -> 擒获 -> 终局
    { fromBeatId: "a1", toBeatId: "a5", relationType: "causal" },
    { fromBeatId: "a5", toBeatId: "b1", relationType: "causal" },
    { fromBeatId: "b2", toBeatId: "b5", relationType: "causal" },
    { fromBeatId: "b5", toBeatId: "d1", relationType: "causal" },
    { fromBeatId: "d1", toBeatId: "d4", relationType: "causal" },
    { fromBeatId: "d4", toBeatId: "e1", relationType: "causal" },
    { fromBeatId: "e1", toBeatId: "e3", relationType: "causal" },
    { fromBeatId: "e3", toBeatId: "e4", relationType: "causal" },
    { fromBeatId: "e4", toBeatId: "f1", relationType: "causal" },
    { fromBeatId: "f1", toBeatId: "f2", relationType: "causal" },
    { fromBeatId: "f4", toBeatId: "g1", relationType: "causal" },
    { fromBeatId: "g1", toBeatId: "g2", relationType: "causal" },
    { fromBeatId: "g2", toBeatId: "g3", relationType: "causal" },
    // 身份揭露链
    { fromBeatId: "c1", toBeatId: "c2", relationType: "causal" },
    { fromBeatId: "c2", toBeatId: "c3", relationType: "causal" },
    { fromBeatId: "c3", toBeatId: "g4", relationType: "causal" },
    // 信任危机与恢复
    { fromBeatId: "d1", toBeatId: "d2", relationType: "causal" },
    { fromBeatId: "d2", toBeatId: "d3", relationType: "causal" },
    // 跨阶段时间序列
    { fromBeatId: "a5", toBeatId: "b1", relationType: "temporal_next" },
    { fromBeatId: "b5", toBeatId: "c1", relationType: "temporal_next" },
    { fromBeatId: "c5", toBeatId: "d1", relationType: "temporal_next" },
    { fromBeatId: "d5", toBeatId: "e1", relationType: "temporal_next" },
    { fromBeatId: "e5", toBeatId: "f1", relationType: "temporal_next" },
    { fromBeatId: "f5", toBeatId: "g1", relationType: "temporal_next" },
    { fromBeatId: "g4", toBeatId: "g5", relationType: "temporal_next" },
  ],
};
