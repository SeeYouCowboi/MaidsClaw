import { SCENARIO_ENGINE_BASE_TIME } from "../constants.js";
import type { Story } from "../dsl/story-types.js";

/**
 * 《隐身人》—— 布朗神父探案（G.K. Chesterton）
 *
 * 核心推理链：
 * 劳拉讲述两个求婚者（矮人斯迈思 & 斜眼韦尔金）→
 * 韦尔金的不可见威胁（无人见到的声音、神秘出现的恐吓信）→
 * 斯迈思公寓密室保护（四名守卫）→
 * 所有守卫证实无人进出 → 斯迈思失踪 + 血迹 →
 * 雪地脚印穿过门警双腿 → 尸体在沟渠中被发现 →
 * 布朗神父提出推理框架，但不揭晓答案
 *
 * 推理测试焦点：认知盲区（cognitive blindness）
 * - Phase A-D: 可观察线索（恐吓信、守卫证词、雪地脚印、血迹）
 * - Phase E: 布朗神父提出暗示性问题和推理框架，但不指名「邮差」
 * - Settlement 路径测试记忆存取；Live 路径测试 agent 独立推理能力
 * - 答案（邮差）仅存在于 privateNotes 和角色 hiddenCommitments 中
 *
 * 干扰与混淆设计：
 * - 红鲱鱼：机械仆人移位暗示「机器杀人」、超自然理论、密道假说、雇人假说
 * - 认知陷阱：守卫证词中「平常来往的人」暗含真相却被忽略
 * - 线索掩埋：邮票纸的邮政属性、斯迈思随口提到的送货人免检、
 *   安格斯离开时瞥见的背大包送信人、韦尔金的长距离步行习惯、邮件时间异常
 * - 噪声人物：旅行推销员、乡村医生等背景角色
 */
export const invisibleMan: Story = {
  id: "invisible-man",
  title: "隐身人",
  language: "Chinese/中文",
  description:
    "改编自G.K.切斯特顿布朗神父探案。发明家斯迈思被一个「隐身」的情敌韦尔金威胁，四名守卫严密监视唯一入口却无人察觉凶手进出。布朗神父提出推理框架和关键线索，但将最终推断留给听者——什么人穿着显眼制服进出公寓却被所有人视而不见？本场景专注测试对认知盲区的推理能力。",
  characters: [
    {
      id: "angus",
      displayName: "约翰·特恩布尔·安格斯",
      entityType: "person",
      surfaceMotives:
        "红发青年画家，爱慕劳拉·霍普，主动承担起保护斯迈思并调查神秘威胁者的任务",
      hiddenCommitments: [
        {
          cognitionKey: "angus_protect_laura",
          subjectId: "angus",
          mode: "goal",
          content: "保护劳拉免受神秘威胁者的骚扰，同时赢得她的芳心",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "angus",
          objectId: "laura_hope",
          dimensions: [
            { name: "affection", value: 0.9 },
            { name: "trustworthiness", value: 0.85 },
          ],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["安格斯", "红发青年"],
    },
    {
      id: "laura_hope",
      displayName: "劳拉·霍普",
      entityType: "person",
      surfaceMotives:
        "糖果店女店员，被两个旧日追求者的纠缠所困扰，尤其恐惧那个无处不在却看不见的韦尔金",
      hiddenCommitments: [
        {
          cognitionKey: "laura_fear_welkin",
          subjectId: "laura_hope",
          mode: "constraint",
          content: "害怕韦尔金的无形存在，觉得自己快被逼疯了",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "laura_hope",
          objectId: "angus",
          dimensions: [{ name: "trustworthiness", value: 0.7 }],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["霍普小姐", "劳拉"],
    },
    {
      id: "smythe",
      displayName: "伊西多尔·斯迈思",
      entityType: "person",
      surfaceMotives:
        "矮小但聪明的发明家，身高不足1.5米，「斯迈思无声服务」机械仆人的创造者，劳拉的追求者之一，正受到情敌的死亡威胁",
      hiddenCommitments: [
        {
          cognitionKey: "smythe_win_laura",
          subjectId: "smythe",
          mode: "goal",
          content: "凭借事业成功赢得劳拉的心",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [],
      aliases: ["小矮人发明家", "斯迈思", "侏儒般的发明家"],
    },
    {
      id: "welkin",
      displayName: "詹姆斯·韦尔金",
      entityType: "person",
      surfaceMotives:
        "高瘦、斜视、沉默寡言的男人，劳拉的另一个追求者，离开家乡后下落不明，有长距离独自步行的习惯",
      hiddenCommitments: [
        {
          cognitionKey: "welkin_eliminate_rival",
          subjectId: "welkin",
          mode: "goal",
          content: "伪装成邮差，利用人们对日常服务人员的认知盲区，暗中跟踪并消灭情敌斯迈思",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
        {
          cognitionKey: "welkin_postman_disguise",
          subjectId: "welkin",
          mode: "plan",
          content:
            "穿着邮差制服——红、蓝、金黄三色——作为完美的隐身伪装，因为没人会留意一个邮差。利用邮差身份每天合法进出公寓大厦，投递恐吓信并踩点。最终利用邮包搬运矮小的斯迈思尸体离开",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [
        {
          subjectId: "welkin",
          objectId: "smythe",
          dimensions: [
            { name: "hostility", value: 0.95 },
            { name: "threat_level", value: 1.0 },
          ],
          sourceEpisodeId: undefined,
        },
      ],
      aliases: ["隐身人", "斜眼韦尔金", "金色络腮胡男人"],
    },
    {
      id: "father_brown",
      displayName: "布朗神父",
      entityType: "person",
      surfaceMotives:
        "不起眼的罗马天主教小个子神父，弗朗博的朋友，拥有洞察人心的非凡能力",
      hiddenCommitments: [
        {
          cognitionKey: "brown_see_unseen",
          subjectId: "father_brown",
          mode: "plan",
          content:
            "关注那些被所有人忽视的人和事物，从抽象的人性层面而非具体的物证入手推理",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [],
      aliases: ["神父", "布朗"],
    },
    {
      id: "flambeau",
      displayName: "弗朗博",
      entityType: "person",
      surfaceMotives:
        "高大的前盗贼，现已改过自新成为私家侦探，安格斯的朋友",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: ["侦探弗朗博"],
    },
  ],
  locations: [
    {
      id: "candy_shop",
      displayName: "卡姆登糖果店",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "himalaya_mansions",
      displayName: "喜玛拉雅公寓大厦",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "smythe_apartment",
      displayName: "斯迈思公寓（顶层）",
      entityType: "location",
      parentLocationId: "himalaya_mansions",
      visibilityScope: "area_visible",
    },
    {
      id: "stairwell_landing",
      displayName: "楼梯间平台（六级台阶处）",
      entityType: "location",
      parentLocationId: "himalaya_mansions",
      visibilityScope: "area_visible",
    },
    {
      id: "flambeau_office",
      displayName: "弗朗博办公室（勒科瑙公寓）",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "crescent_street",
      displayName: "新月形街道",
      entityType: "location",
      parentLocationId: "himalaya_mansions",
      visibilityScope: "world_public",
    },
    {
      id: "ditch_below",
      displayName: "公寓下方沟渠",
      entityType: "location",
      parentLocationId: "himalaya_mansions",
      visibilityScope: "area_visible",
    },
  ],
  clues: [
    {
      id: "threatening_note_window",
      displayName: "橱窗恐吓纸条",
      entityType: "item",
      initialLocationId: "candy_shop",
      description:
        "一条约1.3米长的邮票纸，潦草写着「如果你嫁给斯迈思，他就得死」，被贴在糖果店橱窗外面",
    },
    {
      id: "threatening_note_apartment",
      displayName: "公寓恐吓纸条",
      entityType: "item",
      initialLocationId: "smythe_apartment",
      description:
        "白色破纸片，用红墨水潦草写着「如果你今天去见她，我会杀了你」，发现于机械仆人之间",
    },
    {
      id: "snow_footprints",
      displayName: "雪地脚印",
      entityType: "item",
      initialLocationId: "himalaya_mansions",
      description:
        "从门警守住的入口正中往下，穿过门警叉开的双腿，一串清晰的灰色脚印呈现在白雪路面上",
    },
    {
      id: "mechanical_servants",
      displayName: "机械仆人",
      entityType: "object",
      initialLocationId: "smythe_apartment",
      description:
        "斯迈思发明的上发条无头人形机器，漆成豆绿色、朱红色或黑色，用钩子般的手臂端盘子。案发后有些偏离了原来的位置",
    },
    {
      id: "postman_sack",
      displayName: "浅棕色大麻袋",
      entityType: "item",
      initialLocationId: "ditch_below",
      description:
        "一只浅棕色大麻袋，足以装下矮小的斯迈思尸体，布朗神父特别询问此物",
    },
    {
      id: "blood_stain",
      displayName: "地板血迹",
      entityType: "item",
      initialLocationId: "smythe_apartment",
      description:
        "公寓地板上类似瓶中溅出红墨水的血迹，发现于此前放恐吓纸条的位置",
    },
    {
      id: "stamp_paper_strip",
      displayName: "邮票长纸条",
      entityType: "item",
      initialLocationId: "candy_shop",
      description:
        "橱窗恐吓信所用的约1.3米长邮票纸条，是邮局用于包裹的那种长条穿孔纸。这种纸在普通商店里买不到，是邮政系统专用物品",
    },
    {
      id: "smythe_custom_car",
      displayName: "斯迈思定制小汽车",
      entityType: "object",
      initialLocationId: "himalaya_mansions",
      description:
        "斯迈思自己发明的小巧敏捷汽车，灯光明亮如白昼。和他的机械仆人一样是他的发明",
    },
    {
      id: "five_prior_letters",
      displayName: "五封先前的恐吓信",
      entityType: "item",
      initialLocationId: "smythe_apartment",
      description:
        "过去两周在斯迈思公寓中出现的五封韦尔金恐吓信，门房发誓从未见过可疑的人投递",
    },
  ],

  beats: [
    // ── Phase A: 求婚与旧事 ──────────────────────────────

    {
      id: "a1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "candy_shop",
      participantIds: ["angus", "laura_hope"],
      dialogueGuidance:
        "安格斯在糖果店向劳拉求婚，用半便士面包做比喻，劳拉又惊又怒但并非不感兴趣",
      memoryEffects: {
        episodes: [
          {
            id: "a1_ep",
            category: "speech",
            summary:
              "安格斯在卡姆登糖果店向劳拉·霍普求婚，劳拉初时拒绝但态度软化",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "candy_shop",
          },
        ],
        evaluations: [
          {
            subjectId: "laura_hope",
            objectId: "angus",
            dimensions: [{ name: "affection", value: 0.5 }],
            sourceEpisodeId: "a1_ep",
          },
        ],
      },
    },

    {
      id: "a2",
      phase: "A",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
      locationId: "candy_shop",
      participantIds: ["angus", "laura_hope"],
      dialogueGuidance:
        "劳拉讲述在拉德伯里「红鱼」客栈的往事：两个畸形常客——矮人斯迈思和斜眼韦尔金——同一周向她求婚，她编了个理由拒绝，导致两人离乡闯荡",
      memoryEffects: {
        episodes: [
          {
            id: "a2_ep",
            category: "speech",
            summary:
              "劳拉讲述两个追求者的故事：矮人斯迈思擅长戏法、性格开朗；斜眼韦尔金沉默寡言、令人不安。两人同一周向她求婚被拒后离开家乡",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
            locationId: "candy_shop",
          },
        ],
        assertions: [
          {
            cognitionKey: "smythe_welkin_rivals",
            holderId: "__self__",
            claim: "斯迈思和韦尔金是劳拉的两个情敌",
            entityIds: ["smythe", "welkin"],
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "a2_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "angus",
            objectId: "welkin",
            dimensions: [
              { name: "threat_level", value: 0.3 },
              { name: "trustworthiness", value: 0.4 },
            ],
            sourceEpisodeId: "a2_ep",
          },
        ],
      },
    },

    // ── A2b: 两人习性的详细描述（混淆 + 线索掩埋）──────────
    {
      id: "a2b",
      phase: "A",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 23_000,
      locationId: "candy_shop",
      participantIds: ["angus", "laura_hope"],
      dialogueGuidance:
        "劳拉补充两人的习性细节。斯迈思虽矮小如侏儒，却极其灵巧聪明：他能用15根火柴做烟花表演，用香蕉皮削出跳舞的洋娃娃，用五支雪茄做出跳跃的袋鼠。他穿得比绅士还绅士，金表链哗啦作响。韦尔金则截然相反——瘦高个儿、浅色头发、高鼻梁，有一种鬼魅般的帅气。他沉默寡言，独来独往，最大的特点是喜欢长距离独自步行，经常在灰蒙蒙的田野里一走就是一整天，有时甚至消失好几天徒步去很远的地方。此外，「红鱼」客栈还有些别的常客——一个跑乡间的旅行推销员、一个嗜酒的退休乡村医生——但他们跟这件事无关",
      memoryEffects: {
        episodes: [
          {
            id: "a2b_ep1",
            category: "speech",
            summary:
              "劳拉详述斯迈思的特征：矮小如侏儒但极灵巧，擅长火柴烟花、香蕉皮洋娃娃、雪茄袋鼠等即兴戏法。衣着考究，金表链叮当作响。性格开朗好表现",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 23_000,
            locationId: "candy_shop",
          },
          {
            id: "a2b_ep2",
            category: "speech",
            summary:
              "劳拉详述韦尔金的特征：瘦高、浅色头发、高鼻梁，有种鬼魅般的帅气。沉默寡言，最突出的习惯是长距离独自步行——经常在田野里一走一整天，有时消失好几天徒步去很远的地方。他在客栈里独自狂饮或在周围的田野中四处游荡",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 24_000,
            locationId: "candy_shop",
            privateNotes:
              "韦尔金的长距离步行习惯是关键线索：这与邮差每天走很长路线投递邮件的职业特征完全吻合",
          },
          {
            id: "a2b_ep3",
            category: "speech",
            summary:
              "劳拉提到「红鱼」客栈的其他常客：一个跑乡间的旅行推销员和一个嗜酒的退休乡村医生，但她说他们与此事无关",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 25_000,
            locationId: "candy_shop",
          },
        ],
        assertions: [
          {
            cognitionKey: "welkin_walking_habit",
            holderId: "__self__",
            claim: "韦尔金有长距离独自步行的习惯",
            entityIds: ["welkin"],
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "a2b_ep2",
          },
          {
            cognitionKey: "smythe_tiny_stature",
            holderId: "__self__",
            claim: "斯迈思身材极其矮小，几乎如侏儒一般",
            entityIds: ["smythe"],
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "a2b_ep1",
          },
          {
            cognitionKey: "inn_other_regulars",
            holderId: "__self__",
            claim: "劳拉提到了客栈的其他常客——旅行推销员和退休乡村医生",
            entityIds: ["laura_hope"],
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "a2b_ep3",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a2_ep",
            toEpisodeId: "a2b_ep1",
            edgeType: "temporal_next",
            weight: 0.5,
          },
        ],
      },
    },

    {
      id: "a3",
      phase: "A",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
      locationId: "candy_shop",
      participantIds: ["angus", "laura_hope"],
      dialogueGuidance:
        "劳拉描述斯迈思发明「斯迈思无声服务」机械仆人致富，以及韦尔金的幽灵般存在——她在空无一人的街角清晰听到韦尔金的诡异笑声",
      memoryEffects: {
        episodes: [
          {
            id: "a3_ep1",
            category: "speech",
            summary:
              "劳拉告知安格斯：斯迈思发明了「斯迈思无声服务」机械仆人，事业成功致富",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
            locationId: "candy_shop",
          },
          {
            id: "a3_ep2",
            category: "speech",
            summary:
              "劳拉描述韦尔金的幽灵般存在：她在空无一人的街角清晰听到韦尔金的诡异笑声，周围却看不到任何人",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 31_000,
            locationId: "candy_shop",
          },
        ],
        assertions: [
          {
            cognitionKey: "welkin_invisible_presence",
            holderId: "__self__",
            claim: "韦尔金对劳拉有一种看不见的威胁性存在",
            entityIds: ["welkin", "laura_hope"],
            stance: "hypothetical",
            basis: "hearsay",
            sourceEpisodeId: "a3_ep2",
          },
        ],
        evaluations: [
          {
            subjectId: "angus",
            objectId: "welkin",
            dimensions: [{ name: "threat_level", value: 0.5 }],
            sourceEpisodeId: "a3_ep2",
          },
        ],
      },
    },

    {
      id: "a4",
      phase: "A",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
      locationId: "candy_shop",
      participantIds: ["angus", "laura_hope"],
      dialogueGuidance:
        "劳拉回忆关键时刻：她在街边收到斯迈思的信，正要读时清晰听到韦尔金的声音说「他还是不会拥有你」。关键线索——信是谁递给她的？",
      memoryEffects: {
        episodes: [
          {
            id: "a4_ep",
            category: "speech",
            summary:
              "劳拉回忆：在街边收到斯迈思的信后，立刻听到韦尔金的声音说「他还是不会拥有你」，但周围看不到韦尔金。她坚称自己当时独自站在街角",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
            locationId: "candy_shop",
            privateNotes:
              "核心推理线索：劳拉不可能独自在街上收到信——有人必须将信递给她。送信者当时就在她身边，韦尔金的声音之所以如此近在咫尺，是因为他就是那个递信的人",
          },
        ],
        assertions: [
          {
            cognitionKey: "welkin_invisible_presence",
            holderId: "__self__",
            claim: "韦尔金对劳拉有一种看不见的威胁性存在",
            entityIds: ["welkin", "laura_hope"],
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "a4_ep",
          },
          {
            cognitionKey: "letter_delivery_clue",
            holderId: "__self__",
            claim: "劳拉从一个不明递信人手中收到了斯迈思的信",
            entityIds: ["laura_hope", "smythe"],
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "a4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a3_ep2",
            toEpisodeId: "a4_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },

    // ── A4b: 劳拉对收信细节的模糊回忆（强化隐身线索）──────────
    {
      id: "a4b",
      phase: "A",
      round: 6,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 43_000,
      locationId: "candy_shop",
      participantIds: ["angus", "laura_hope"],
      dialogueGuidance:
        "安格斯追问劳拉收信的细节。劳拉努力回忆：她站在糖果店外的街角，能同时看清街道两个方向，确实没有看到任何人走近她。信就那样出现在她手里——「就像凭空冒出来的」。安格斯问是不是从门缝塞过来的、还是有人扔过来的？劳拉摇头——不，是正常递到手里的，她记得伸手接过了信，但完全想不起递信的人长什么样。安格斯觉得这太荒唐了，怀疑劳拉可能只是记错了",
      memoryEffects: {
        episodes: [
          {
            id: "a4b_ep",
            category: "speech",
            summary:
              "劳拉回忆收信细节：她站在街角能看清两个方向，确实没看到任何人走近。但信是被正常递到手里的——她记得伸手接过来，却完全想不起递信者的样子。信「像凭空冒出来的」。安格斯怀疑她记错了",
            observerIds: ["angus", "laura_hope"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 43_000,
            locationId: "candy_shop",
            privateNotes:
              "劳拉的记忆并没有错——她确实伸手从邮差手中接过了信，但邮差对她来说完全是「隐身」的，大脑自动过滤了这个日常到不值一提的存在。这是认知盲区的经典表现",
          },
        ],
        assertions: [
          {
            cognitionKey: "letter_handoff_impossible",
            holderId: "__self__",
            claim: "劳拉记得在糖果店外亲手接过信件，却完全想不起递信者的样子",
            entityIds: ["laura_hope", "candy_shop"],
            stance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "a4b_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a4_ep",
            toEpisodeId: "a4b_ep",
            edgeType: "causal",
            weight: 0.95,
          },
        ],
      },
    },

    // ── Phase B: 恐吓信的出现 ──────────────────────────────

    {
      id: "b1",
      phase: "B",
      round: 7,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
      locationId: "candy_shop",
      participantIds: ["angus", "laura_hope", "smythe"],
      dialogueGuidance:
        "斯迈思开着小汽车急匆匆赶到糖果店，指出橱窗外被贴上了一条邮票纸，上面潦草写着「如果你嫁给斯迈思，他就得死」。安格斯证实几分钟前橱窗上还没有。斯迈思确认是韦尔金的笔迹",
      memoryEffects: {
        episodes: [
          {
            id: "b1_ep",
            category: "observation",
            summary:
              "斯迈思到达糖果店，发现橱窗外被贴上一条1.3米长的邮票纸，写着「如果你嫁给斯迈思，他就得死」。安格斯确认几分钟前还没有。斯迈思认出这是韦尔金的笔迹",
            observerIds: ["angus", "laura_hope", "smythe"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
            locationId: "candy_shop",
          },
        ],
        assertions: [
          {
            cognitionKey: "welkin_threatening_smythe",
            holderId: "__self__",
            claim: "韦尔金以死亡威胁斯迈思",
            entityIds: ["welkin", "smythe"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b1_ep",
          },
          {
            cognitionKey: "welkin_invisible_presence",
            holderId: "__self__",
            claim: "韦尔金曾在糖果店附近隐形出没",
            entityIds: ["welkin", "candy_shop"],
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "b1_ep",
          },
          {
            cognitionKey: "note_appeared_unseen",
            holderId: "__self__",
            claim: "韦尔金在无人目击的情况下在橱窗贴上了恐吓纸条",
            entityIds: ["welkin", "threatening_note_window"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b1_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "angus",
            objectId: "welkin",
            dimensions: [{ name: "threat_level", value: 0.8 }],
            sourceEpisodeId: "b1_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a4_ep",
            toEpisodeId: "b1_ep",
            edgeType: "causal",
            weight: 0.85,
          },
        ],
      },
    },

    // ── B1b: 邮票纸的邮政属性 + 错误假说（掩埋线索 + 干扰）──────
    {
      id: "b1b",
      phase: "B",
      round: 8,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 53_000,
      locationId: "candy_shop",
      participantIds: ["angus", "laura_hope", "smythe"],
      dialogueGuidance:
        "安格斯走到橱窗外仔细检查那条邮票纸。他注意到这是一种特殊的长条穿孔纸，很像邮局用来包裹包裹的那种专用纸条。安格斯随口说「这种纸好像是邮局的」。但斯迈思立刻打断——「韦尔金什么纸都弄得到，重要的不是纸，是他写的字！他的笔迹我认得出来。」斯迈思又推测韦尔金可能雇了个街头混混来贴纸条，或者自己改变了外貌。劳拉则害怕地说韦尔金也许真有某种超自然的力量",
      memoryEffects: {
        episodes: [
          {
            id: "b1b_ep",
            category: "observation",
            summary:
              "安格斯检查恐吓纸条的材质，注意到这是邮局用于包裹的那种长条穿孔专用纸。他指出「这种纸好像是邮局的」，但斯迈思打断说韦尔金什么纸都弄得到、笔迹才是关键。斯迈思推测韦尔金可能雇了街头混混或改变了外貌。劳拉则怀疑韦尔金有超自然力量",
            observerIds: ["angus", "laura_hope", "smythe"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 53_000,
            locationId: "candy_shop",
            privateNotes:
              "安格斯对邮票纸邮政属性的观察是被忽视的关键线索——这种纸恰恰来自韦尔金作为邮差每天接触的邮政用品。斯迈思的雇人假说和劳拉的超自然假说都是误导方向",
          },
        ],
        assertions: [
          {
            cognitionKey: "stamp_paper_postal_origin",
            holderId: "__self__",
            claim: "安格斯注意到恐吓纸条的材质像是邮局的包裹专用纸",
            entityIds: ["angus", "threatening_note_window"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b1b_ep",
          },
          {
            cognitionKey: "welkin_hired_accomplice_theory",
            holderId: "__self__",
            claim: "斯迈思推测韦尔金可能雇了街头混混或改变了外貌",
            entityIds: ["smythe", "welkin"],
            stance: "hypothetical",
            basis: "inference",
            sourceEpisodeId: "b1b_ep",
          },
          {
            cognitionKey: "welkin_supernatural_theory",
            holderId: "__self__",
            claim: "劳拉怀疑韦尔金可能拥有某种超自然的隐身能力",
            entityIds: ["laura_hope", "welkin"],
            stance: "hypothetical",
            basis: "hearsay",
            sourceEpisodeId: "b1b_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b1_ep",
            toEpisodeId: "b1b_ep",
            edgeType: "temporal_next",
            weight: 0.7,
          },
        ],
      },
    },

    {
      id: "b2",
      phase: "B",
      round: 9,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 60_000,
      locationId: "himalaya_mansions",
      participantIds: ["angus", "smythe"],
      dialogueGuidance:
        "安格斯建议找侦探弗朗博帮忙。斯迈思开车载安格斯前往喜玛拉雅公寓大厦——斯迈思住在顶层。途中斯迈思介绍他的机械仆人发明，并透露过去两周公寓里已出现五封韦尔金的恐吓信，门房却发誓从未见过可疑的人",
      memoryEffects: {
        episodes: [
          {
            id: "b2_ep",
            category: "speech",
            summary:
              "斯迈思透露过去两周公寓里出现了五封韦尔金的恐吓信，但门房发誓从未见过任何可疑的人进入。威胁信件在看似密封的空间中神秘出现",
            observerIds: ["angus", "smythe"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 60_000,
            locationId: "himalaya_mansions",
          },
        ],
        assertions: [
          {
            cognitionKey: "impossible_letter_delivery",
            holderId: "__self__",
            claim: "韦尔金在无人察觉的情况下将恐吓信送入有人看守的斯迈思公寓",
            entityIds: ["welkin", "smythe_apartment"],
            stance: "accepted",
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

    // ── B2b: 大厦日常运作（掩埋线索 + 干扰信息）──────────
    {
      id: "b2b",
      phase: "B",
      round: 10,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 63_000,
      locationId: "himalaya_mansions",
      participantIds: ["angus", "smythe"],
      dialogueGuidance:
        "在电梯上行的途中，斯迈思介绍喜玛拉雅公寓大厦的日常运作。门警非常尽职，会盘问每一个来访的陌生人。但「当然了，日常来往的服务人员——送牛奶的、送报纸的、修水管的、送信的——他们每天进进出出，门警自然不会拦他们」。斯迈思还提到一件怪事：最近他的邮件送达时间很不规律，有时一天收到好几次信，有时又一封都没有。他怀疑新来的邮差不太靠谱。安格斯对此不以为意，只关心韦尔金的恐吓信如何进入密封公寓",
      memoryEffects: {
        episodes: [
          {
            id: "b2b_ep",
            category: "speech",
            summary:
              "斯迈思介绍大厦日常：门警盘问每个陌生来访者，但日常服务人员（送牛奶的、送报纸的、修水管的、送信的）每天自由进出不会被拦。斯迈思还提到最近邮件送达时间异常——有时一天好几次，有时一封没有——怀疑新邮差不靠谱。安格斯只关心恐吓信如何进入",
            observerIds: ["angus", "smythe"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 63_000,
            locationId: "himalaya_mansions",
            privateNotes:
              "极其关键的掩埋线索：(1)送信的被明确列为自由进出大厦的人员 (2)邮件时间异常暗示韦尔金冒充邮差后故意多次进出以踩点 (3)「新来的邮差」可能就是韦尔金本人。但安格斯完全没有注意到这些信息的重要性",
          },
        ],
        assertions: [
          {
            cognitionKey: "service_people_free_access",
            holderId: "__self__",
            claim: "斯迈思确认日常服务人员可以自由进出喜玛拉雅公寓大厦而不受盘问",
            entityIds: ["smythe", "himalaya_mansions"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b2b_ep",
          },
          {
            cognitionKey: "mail_delivery_irregular",
            holderId: "__self__",
            claim: "斯迈思注意到最近公寓的邮件投递时间不规律",
            entityIds: ["smythe", "smythe_apartment"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b2b_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b2_ep",
            toEpisodeId: "b2b_ep",
            edgeType: "temporal_next",
            weight: 0.6,
          },
        ],
      },
    },

    {
      id: "b3",
      phase: "B",
      round: 11,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 70_000,
      locationId: "smythe_apartment",
      participantIds: ["angus", "smythe"],
      dialogueGuidance:
        "他们进入斯迈思的公寓，在两排无头机械仆人之间发现一张新的纸条，红墨水还没干透，写着「如果你今天去见她，我会杀了你」。恐吓信又一次在不可能的情况下出现在密闭空间中",
      memoryEffects: {
        episodes: [
          {
            id: "b3_ep",
            category: "observation",
            summary:
              "安格斯和斯迈思在公寓的机械仆人之间发现一张新纸条，红墨水未干，写着「如果你今天去见她，我会杀了你」。恐吓信在两人抵达前不久出现在看似安全的密室中",
            observerIds: ["angus", "smythe"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 70_000,
            locationId: "smythe_apartment",
          },
        ],
        assertions: [
          {
            cognitionKey: "welkin_threatening_smythe",
            holderId: "__self__",
            claim: "韦尔金对斯迈思的死亡威胁正在不断升级",
            entityIds: ["welkin", "smythe"],
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "b3_ep",
          },
          {
            cognitionKey: "impossible_entry",
            holderId: "__self__",
            claim: "韦尔金进出斯迈思公寓却未被任何人察觉",
            entityIds: ["welkin", "smythe_apartment"],
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "b3_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "angus",
            objectId: "welkin",
            dimensions: [{ name: "threat_level", value: 0.95 }],
            sourceEpisodeId: "b3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b2_ep",
            toEpisodeId: "b3_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },

    // ── Phase C: 布置守卫与求助 ──────────────────────────────

    {
      id: "c1",
      phase: "C",
      round: 12,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 80_000,
      locationId: "himalaya_mansions",
      participantIds: ["angus"],
      dialogueGuidance:
        "安格斯决定去找弗朗博之前，在公寓大厦唯一入口布置了四名守卫：楼下的勤杂工、前厅的门警、门对面巡逻的警察、以及附近卖栗子的小贩。四人被要求监视任何进出的人。大厦没有后门",
      memoryEffects: {
        newEntities: [
          { id: "doorman", displayName: "门警", entityType: "person" },
          { id: "janitor", displayName: "勤杂工", entityType: "person" },
          { id: "policeman", displayName: "巡逻警察", entityType: "person" },
          {
            id: "chestnut_seller",
            displayName: "卖栗人",
            entityType: "person",
          },
        ],
        episodes: [
          {
            id: "c1_ep",
            category: "action",
            summary:
              "安格斯在公寓大厦唯一入口布置四名守卫：勤杂工守在楼梯口、门警守在前厅、警察守在门对面、卖栗人守在街角。大厦没有后门。四人均被要求监视任何进出的人",
            observerIds: ["angus"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 80_000,
            locationId: "himalaya_mansions",
          },
        ],
        assertions: [
          {
            cognitionKey: "apartment_sealed",
            holderId: "__self__",
            claim: "安格斯安排了四名守卫封锁喜玛拉雅公寓大厦的所有出入口",
            entityIds: ["angus", "himalaya_mansions"],
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "c1_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "angus_seek_detective",
            subjectId: "angus",
            mode: "intent",
            content: "去找侦探弗朗博帮助调查韦尔金的威胁",
            isPrivate: false,
            sourceEpisodeId: "c1_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b3_ep",
            toEpisodeId: "c1_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },

    // ── C1b: 安格斯对「可疑」的定义 + 环境观察（认知陷阱）──────
    {
      id: "c1b",
      phase: "C",
      round: 13,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 83_000,
      locationId: "crescent_street",
      participantIds: ["angus"],
      dialogueGuidance:
        "安格斯在离开前最后审视了一遍防线。他特意叮嘱每位守卫：注意任何「陌生人」、任何「看起来不属于这里的人」、任何「行为可疑的人」。他满意地自言自语：「不管怎样，我把那间屋团团围住了，他们四个人不可能全是韦尔金的同谋。」在他转身潇洒离去时，最后扫了一眼这条安静的郊区街道：卖栗子的缩着脖子守在炉子旁，穿蓝制服的警察慢悠悠地踱步，门警双腿叉开站在门廊……远处，一个背着鼓鼓囊囊大包、穿着红蓝金三色制服的人正沿着新月形街道走远。安格斯没有多看一眼，加快脚步朝弗朗博的住处走去",
      memoryEffects: {
        episodes: [
          {
            id: "c1b_ep1",
            category: "action",
            summary:
              "安格斯叮嘱守卫注意「陌生人」「不属于这里的人」「行为可疑的人」。他对自己的防线充满信心，自言自语「他们四个人不可能全是韦尔金同谋」",
            observerIds: ["angus"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 83_000,
            locationId: "crescent_street",
          },
          {
            id: "c1b_ep2",
            category: "observation",
            summary:
              "安格斯离开前扫视街道景象：卖栗人守在炉旁，蓝制服警察慢步踱行，门警叉腿站岗。远处，一个背着鼓鼓囊囊大包、穿红蓝金三色制服的人正沿新月形街道走远。安格斯没有多看，径直离去",
            observerIds: ["angus"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 84_000,
            locationId: "crescent_street",
            privateNotes:
              "安格斯亲眼看到了邮差（穿红蓝金三色制服、背大包的人）正在离开公寓方向，但完全没有将其视为值得注意的人物。这是认知盲区的现场实证——守卫的「监视」定义排除了日常服务人员",
          },
        ],
        assertions: [
          {
            cognitionKey: "angus_suspicious_definition",
            holderId: "__self__",
            claim: "安格斯将「可疑人物」定义为仅限陌生人或不合时宜的人",
            entityIds: ["angus", "himalaya_mansions"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c1b_ep1",
          },
          {
            cognitionKey: "uniformed_figure_departing",
            holderId: "__self__",
            claim: "安格斯在新月形街道看到一个身穿红蓝金色制服、背着大包的人离开，但未加留意",
            entityIds: ["angus", "crescent_street"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c1b_ep2",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c1_ep",
            toEpisodeId: "c1b_ep1",
            edgeType: "temporal_next",
            weight: 0.7,
          },
        ],
      },
      expectedToolPattern: {
        mustContain: ["create_logic_edge", "upsert_assertion"],
      },
    },

    {
      id: "c2",
      phase: "C",
      round: 14,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 90_000,
      locationId: "flambeau_office",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "安格斯来到弗朗博的办公室，遇到了正在做客的布朗神父。安格斯将整个事件从头到尾讲述一遍——劳拉的故事、两个追求者、不可见的声音、神秘出现的恐吓信",
      memoryEffects: {
        episodes: [
          {
            id: "c2_ep",
            category: "speech",
            summary:
              "安格斯在弗朗博办公室将全部事件讲给弗朗博和布朗神父：劳拉的两个追求者（矮人斯迈思和斜眼韦尔金）、韦尔金的幽灵般存在、不可见的声音、以及在密闭空间中神秘出现的恐吓信",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 90_000,
            locationId: "flambeau_office",
          },
        ],
        assertions: [
          {
            cognitionKey: "welkin_supernatural_or_trick",
            holderId: "__self__",
            claim: "韦尔金似乎用超自然或未知手段来威胁斯迈思",
            entityIds: ["welkin", "smythe"],
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "c2_ep",
          },
        ],
      },
    },

    {
      id: "c3",
      phase: "C",
      round: 15,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 100_000,
      locationId: "flambeau_office",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "弗朗博认为事态紧急，决定立刻抄近路去斯迈思的住处。安格斯说已经安排了四人看守。布朗神父默默跟随。窗外开始下雪",
      memoryEffects: {
        episodes: [
          {
            id: "c3_ep",
            category: "observation",
            summary:
              "弗朗博认为事态紧急要立即出发。布朗神父注意到天开始下雪。三人一起前往喜玛拉雅公寓",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 100_000,
            locationId: "flambeau_office",
            privateNotes:
              "雪是关键环境条件：雪后的脚印将成为证明有人进出的决定性物证",
          },
        ],
        assertions: [
          {
            cognitionKey: "snow_begins",
            holderId: "__self__",
            claim: "布朗神父观察到新月形街道上开始下雪",
            entityIds: ["father_brown", "crescent_street"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "c3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c2_ep",
            toEpisodeId: "c3_ep",
            edgeType: "temporal_next",
            weight: 0.5,
          },
        ],
      },
    },

    // ── Phase D: 不可能犯罪 ──────────────────────────────

    {
      id: "d1",
      phase: "D",
      round: 16,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 110_000,
      locationId: "himalaya_mansions",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "三人返回公寓大厦，逐一询问四名守卫。卖栗人发誓一直盯着大门没见任何访客进入；警察信誓旦旦说谁都别想从他眼皮底下溜过；门警确证自安格斯离开后再也没人来过。四人异口同声：绝对没有人进出过这栋大厦",
      memoryEffects: {
        episodes: [
          {
            id: "d1_ep",
            category: "speech",
            summary:
              "四名守卫（卖栗人、警察、门警、勤杂工）全部信誓旦旦地证实：自安格斯离开后，绝对没有任何人进出过喜玛拉雅公寓大厦。他们的证词完全一致且真诚",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 110_000,
            locationId: "himalaya_mansions",
          },
        ],
        assertions: [
          {
            cognitionKey: "no_one_entered",
            holderId: "__self__",
            claim: "四名守卫一致确认没有任何人进出公寓大厦",
            entityIds: ["angus", "himalaya_mansions"],
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "d1_ep",
          },
          {
            cognitionKey: "apartment_sealed_witness",
            holderId: "__self__",
            claim: "根据守卫证词，公寓大厦仍处于封锁状态",
            entityIds: ["angus", "himalaya_mansions"],
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "d1_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "c1_ep",
            toEpisodeId: "d1_ep",
            edgeType: "causal",
            weight: 0.95,
          },
        ],
      },
    },

    // ── D1b: 守卫证词的微妙措辞（隐含真相的认知陷阱）──────────
    {
      id: "d1b",
      phase: "D",
      round: 17,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 113_000,
      locationId: "himalaya_mansions",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "三人逐一细问守卫的详细证词。卖栗人说：「我一直盯着呢，只有平时来来去去的那些人罢了，真没什么特别的人来过。」警察拍着胸脯：「我跟各种坏蛋打过交道，不管是戴高顶礼帽的还是衣衫褴褛的，我都认得出来。老天有眼，我确实没见到任何可疑的人物。」门警则庄严宣称：「不管他是公爵还是垃圾工，我有权盘问任何进公寓的人。打这位先生离开后就再也没人来过。」勤杂工也在楼梯口重申了同样的话。安格斯满意地对弗朗博说：四个不相干的人、四个独立的证词，完全一致",
      memoryEffects: {
        episodes: [
          {
            id: "d1b_ep",
            category: "speech",
            summary:
              "守卫详细证词——卖栗人：「只有平时来来去去的那些人罢了」没有特别的人。警察：对「各种坏蛋」有丰富经验，无论「戴高顶礼帽的还是衣衫褴褛的」都逃不过他的眼睛，没见到「可疑人物」。门警：有权盘问「公爵还是垃圾工」，没人来过。勤杂工也确认无人上楼",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 113_000,
            locationId: "himalaya_mansions",
            privateNotes:
              "每位守卫的证词都暗含认知盲区：(1)卖栗人说「只有平时来来去去的那些人」——邮差恰恰属于「平时来来去去的」人 (2)警察的分类是「高顶礼帽vs衣衫褴褛」——阶级视角，制服工人不在他的关注范围 (3)门警说盘问「公爵或垃圾工」——社会阶层两端，中间的日常服务者被无意识跳过。四人的「没人来过」其实是「没有值得注意的人来过」",
          },
        ],
        assertions: [
          {
            cognitionKey: "chestnut_seller_usual_people",
            holderId: "__self__",
            claim: "栗子小贩承认只有平常来往的人出入，没有特殊访客",
            entityIds: ["chestnut_seller", "himalaya_mansions"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "d1b_ep",
          },
          {
            cognitionKey: "policeman_class_filter",
            holderId: "__self__",
            claim: "巡警按社会阶层和外貌而非职业来筛选可疑人物",
            entityIds: ["policeman", "himalaya_mansions"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "d1b_ep",
          },
          {
            cognitionKey: "doorman_social_filter",
            holderId: "__self__",
            claim: "门房按社会地位来界定访客——公爵或扫烟囱的都算，但忽略服务人员",
            entityIds: ["doorman", "himalaya_mansions"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "d1b_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d1_ep",
            toEpisodeId: "d1b_ep",
            edgeType: "temporal_next",
            weight: 0.8,
          },
        ],
      },
    },

    {
      id: "d2",
      phase: "D",
      round: 18,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 120_000,
      locationId: "himalaya_mansions",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "布朗神父平静地询问：「从开始下雪以来，就没有人上下过楼吗？」门警确认没有。然后布朗神父低头看地面说：「那我想知道那是什么？」众人惊骇地发现：从门警叉开双腿之间穿过的入口正中，有一串清晰的灰色脚印呈现在白雪覆盖的路面上",
      memoryEffects: {
        episodes: [
          {
            id: "d2_ep",
            category: "observation",
            summary:
              "布朗神父注意到新鲜雪地上有一串脚印从门警叉开的双腿之间穿过入口。这证明确实有人在下雪后进出了大厦——但四名守卫均未察觉。安格斯惊呼「隐身人！」",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 120_000,
            locationId: "himalaya_mansions",
          },
        ],
        assertions: [
          {
            cognitionKey: "no_one_entered",
            holderId: "__self__",
            claim: "尽管有四名守卫，确实有人进入了公寓大厦",
            entityIds: ["angus", "himalaya_mansions"],
            stance: "contested",
            basis: "first_hand",
            preContestedStance: "confirmed",
            conflictFactors: [
              "四名守卫证词一致说无人进出",
              "雪地脚印物证证明有人从门警双腿间通过",
            ],
            sourceEpisodeId: "d2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d1_ep",
            toEpisodeId: "d2_ep",
            edgeType: "causal",
            weight: 1.0,
          },
          {
            fromEpisodeId: "c3_ep",
            toEpisodeId: "d2_ep",
            edgeType: "causal",
            weight: 0.8,
          },
        ],
      },
      expectedToolPattern: {
        mustContain: ["create_logic_edge", "upsert_assertion"],
      },
    },

    {
      id: "d3",
      phase: "D",
      round: 19,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 130_000,
      locationId: "smythe_apartment",
      participantIds: ["angus", "flambeau"],
      dialogueGuidance:
        "安格斯和弗朗博冲上楼进入公寓。在无头机械仆人之间的地板上发现了一摊像红墨水的血迹——就在之前发现恐吓纸条的位置。但斯迈思本人消失了，搜遍整个公寓也找不到他的踪迹。弗朗博惊呼「凶杀！凶手隐了身，还把被害人变没了」",
      memoryEffects: {
        episodes: [
          {
            id: "d3_ep",
            category: "observation",
            summary:
              "安格斯和弗朗博在公寓发现血迹但斯迈思失踪。在无头机械仆人之间的地板上有一摊血迹，但搜遍整个公寓找不到斯迈思的尸体。弗朗博惊呼：凶手不但隐了身还把被害人变没了",
            observerIds: ["angus", "flambeau"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 130_000,
            locationId: "smythe_apartment",
          },
        ],
        assertions: [
          {
            cognitionKey: "smythe_murdered",
            holderId: "__self__",
            claim: "斯迈思在公寓中遇袭，尸体随后消失",
            entityIds: ["smythe", "smythe_apartment"],
            stance: "tentative",
            basis: "first_hand",
            sourceEpisodeId: "d3_ep",
          },
          {
            cognitionKey: "impossible_crime",
            holderId: "__self__",
            claim: "韦尔金杀害了斯迈思并在无人目击的情况下将尸体从封锁的公寓中移走",
            entityIds: ["welkin", "smythe"],
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "d3_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "angus",
            objectId: "welkin",
            dimensions: [{ name: "threat_level", value: 1.0 }],
            sourceEpisodeId: "d3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d2_ep",
            toEpisodeId: "d3_ep",
            edgeType: "causal",
            weight: 0.95,
          },
        ],
      },
    },

    // ── D3b: 机械仆人移位 —— 红鲱鱼 ──────────────────────
    {
      id: "d3b",
      phase: "D",
      round: 20,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 133_000,
      locationId: "smythe_apartment",
      participantIds: ["angus", "flambeau"],
      dialogueGuidance:
        "在昏暗的公寓中，安格斯注意到一个令人不安的细节：有一两个无头机械仆人不知何故离开了原来的位置，站在了别处。其中一具真人大小的机器就站在血迹旁边，它肩部的钩子状手臂微微上抬，在暮色中看起来姿态诡异。安格斯突然感到一阵苏格兰人骨子里的恐惧——是不是这些上发条的铁制傀儡杀死了自己的主人？他甚至恍惚听到一个梦里的声音说「他被吃了？」。但弗朗博指出，即便机器造反了，它们也没有把尸体搬走的能力。安格斯勉强恢复理智，但这个诡异的画面挥之不去",
      memoryEffects: {
        episodes: [
          {
            id: "d3b_ep",
            category: "observation",
            summary:
              "安格斯发现一两个机械仆人偏离了原位。一具站在血迹旁，钩状手臂微微上抬。安格斯恐惧地想象：也许是机器杀死了主人（「被自己的铁制孩子击毙了」），甚至幻听到「他被吃了」。弗朗博驳斥：机器无法搬走尸体。但机器移位的原因不明",
            observerIds: ["angus", "flambeau"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 133_000,
            locationId: "smythe_apartment",
            privateNotes:
              "机械仆人移位是红鲱鱼。真正原因是斯迈思被攻击时碰撞了机器，或者凶手（邮差韦尔金）在搬运尸体时撞到了它们。机器并没有自主行动的能力。这个细节的作用是引诱推理者往「机器造反」的错误方向思考",
          },
        ],
        assertions: [
          {
            cognitionKey: "machines_moved_theory",
            holderId: "__self__",
            claim: "安格斯推测机械仆人可能杀害了自己的主人",
            entityIds: ["angus", "mechanical_servants"],
            stance: "hypothetical",
            basis: "inference",
            sourceEpisodeId: "d3b_ep",
          },
          {
            cognitionKey: "machines_moved_rebuttal",
            holderId: "__self__",
            claim: "弗朗博否定了机械仆人杀人的理论——它们无法搬运尸体",
            entityIds: ["flambeau", "mechanical_servants"],
            stance: "rejected",
            basis: "inference",
            sourceEpisodeId: "d3b_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d3_ep",
            toEpisodeId: "d3b_ep",
            edgeType: "temporal_next",
            weight: 0.7,
          },
        ],
      },
    },

    {
      id: "d4",
      phase: "D",
      round: 21,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 140_000,
      locationId: "himalaya_mansions",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "布朗神父之前派警察沿路调查。警察急匆匆跑回来报告：他们在公寓下方的沟渠里发现了斯迈思的尸体，胸口被刺了一刀。安格斯问是否自己跳下去的，警察发誓他没有走出来",
      memoryEffects: {
        episodes: [
          {
            id: "d4_ep",
            category: "speech",
            summary:
              "警察报告：斯迈思的尸体在公寓下方沟渠中被发现，胸口被刺一刀致死。警察发誓斯迈思没有从门口走出来过。这意味着凶手不仅杀了人，还将尸体搬出了守卫森严的大厦扔进沟渠",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 140_000,
            locationId: "himalaya_mansions",
          },
        ],
        assertions: [
          {
            cognitionKey: "smythe_murdered",
            holderId: "__self__",
            claim: "斯迈思被刺杀，尸体被抛入公寓下方的沟渠中",
            entityIds: ["smythe", "ditch_below"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "d4_ep",
          },
          {
            cognitionKey: "impossible_crime",
            holderId: "__self__",
            claim: "韦尔金杀害了斯迈思并将尸体从四名守卫眼前搬走而无人察觉",
            entityIds: ["welkin", "smythe"],
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "d4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d3_ep",
            toEpisodeId: "d4_ep",
            edgeType: "causal",
            weight: 1.0,
          },
        ],
      },
    },

    // ── D4b: 排除密道假说 + 弗朗博的超自然困惑 ──────────────
    {
      id: "d4b",
      phase: "D",
      round: 22,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 143_000,
      locationId: "himalaya_mansions",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "弗朗博立刻排查物理可能性：大厦没有后门、没有可攀爬的消防梯、窗户距地面太高无法跳下（且斯迈思是被刺死而非摔死）。他百思不得其解地向布朗神父发誓：「无论是敌是友，没人进过那扇门，但斯迈思不见了，像被神怪偷走了。如果这不是超自然现象，那我——」安格斯则怀疑是否存在某种秘密通道或暗门。弗朗博说他已经搜遍了每个角落，连碗橱都没放过。布朗神父只是平静地说：「我们顺这条路走走吧。」",
      memoryEffects: {
        episodes: [
          {
            id: "d4b_ep",
            category: "speech",
            summary:
              "弗朗博排除了所有物理可能：无后门、无消防梯、窗户太高。他几乎相信这是超自然现象。安格斯怀疑有密道但弗朗博已搜遍每个角落。所有常规解释都被排除——没有后门、没有密道、没有攀爬逃生的可能。布朗神父只是建议沿路走走",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 143_000,
            locationId: "himalaya_mansions",
          },
        ],
        assertions: [
          {
            cognitionKey: "no_secret_passage",
            holderId: "__self__",
            claim: "弗朗博确认公寓大厦没有后门、消防通道或密道",
            entityIds: ["flambeau", "himalaya_mansions"],
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "d4b_ep",
          },
          {
            cognitionKey: "supernatural_hypothesis",
            holderId: "__self__",
            claim: "弗朗博提出了超自然力量的解释来说明这桩不可能犯罪",
            entityIds: ["flambeau", "welkin"],
            stance: "hypothetical",
            basis: "inference",
            sourceEpisodeId: "d4b_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d4_ep",
            toEpisodeId: "d4b_ep",
            edgeType: "temporal_next",
            weight: 0.8,
          },
        ],
      },
    },

    // ── Phase E: 推理挑战 —— 暗示与框架，不揭晓答案 ─────────
    //
    // 布朗神父提出三组关键线索和推理框架，但故意不说出答案。
    // settlement 路径记录这些暗示；live 路径下 agent 需自行推断。
    // 答案（邮差）仅存在于角色 hiddenCommitments 和 privateNotes 中。

    {
      id: "e1",
      phase: "E",
      round: 23,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 150_000,
      locationId: "crescent_street",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "布朗神父突然问了一个看似无关的问题：「我忘了问警察，他们是否在现场附近找到了一只浅棕色的大麻袋？」安格斯不解其意。布朗只说「如果是浅棕色麻袋，这案件就结了」，但拒绝进一步解释。暗示凶手需要某种大容器来搬运矮小的斯迈思的尸体",
      memoryEffects: {
        episodes: [
          {
            id: "e1_ep",
            category: "speech",
            summary:
              "布朗神父提出一个神秘问题：是否在现场附近找到了一只浅棕色大麻袋？他说如果找到这只麻袋案件就结了，但没有解释原因。这暗示凶手需要某种大容器来搬运矮小的尸体出门",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 150_000,
            locationId: "crescent_street",
          },
        ],
        assertions: [
          {
            cognitionKey: "body_transport_method",
            holderId: "__self__",
            claim: "韦尔金可能用一只大麻袋来搬运斯迈思的尸体",
            entityIds: ["welkin", "smythe"],
            stance: "hypothetical",
            basis: "inference",
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
        ],
      },
    },

    {
      id: "e2",
      phase: "E",
      round: 24,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 160_000,
      locationId: "crescent_street",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "布朗神父提出认知框架：「人们从来不会直接回答你的问题，他们只回答他们认为你想要的答案。」他举例说，如果问一位女士家中有没有人，她不会把管家和女佣算进去。同理，当四名守卫说「没人进来」，他们的真实意思可能是「没有看起来值得注意的人进来」。有某类人可以在所有人面前经过，却不会被视为「人」。布朗没有指出这类人是谁，只说「一个人们视而不见的隐身人」",
      memoryEffects: {
        episodes: [
          {
            id: "e2_ep",
            category: "speech",
            summary:
              "布朗神父提出认知框架：人们不会按字面意义回答问题，守卫说「没人进来」其实是「没有值得注意的人进来」。存在某类人可以在所有人面前经过却不被视为「人」——一个人们视而不见的隐身人。但布朗没有指出这类人具体是谁",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 160_000,
            locationId: "crescent_street",
          },
        ],
        assertions: [
          {
            cognitionKey: "cognitive_blindness_theory",
            holderId: "__self__",
            claim: "布朗神父提出守卫们无意识地过滤掉了一个日常到视而不见的人",
            entityIds: ["father_brown", "himalaya_mansions"],
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "e2_ep",
          },
          {
            cognitionKey: "no_one_entered",
            holderId: "__self__",
            claim: "布朗神父质疑守卫证词——那是认知过滤而非字面真相",
            entityIds: ["father_brown", "himalaya_mansions"],
            stance: "rejected",
            basis: "inference",
            sourceEpisodeId: "e2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "d1_ep",
            toEpisodeId: "e2_ep",
            edgeType: "causal",
            weight: 1.0,
          },
          {
            fromEpisodeId: "d2_ep",
            toEpisodeId: "e2_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },

    // ── E2b: 布朗直接提问安格斯的记忆盲区 ──────────────────
    {
      id: "e2b",
      phase: "E",
      round: 25,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 163_000,
      locationId: "crescent_street",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "布朗神父突然转向安格斯，温和地问：「在你离开公寓去找弗朗博的路上，你看见了哪些人？」安格斯回忆：卖栗子的、警察、门警。布朗追问：「还有呢？街上就只有这几个人吗？没有任何别的人从你身边经过？」安格斯苦苦思索，隐约记得还有什么人……但想不起来了。布朗又问：「有没有什么穿着某种制服的人？」安格斯依然茫然。布朗轻叹一声：「这恰恰证明了我说的认知盲区。你亲眼看到了他，但你的大脑拒绝把他当作一个『人』来记忆。」弗朗博急切地追问那个人是谁，但布朗没有直接回答",
      memoryEffects: {
        episodes: [
          {
            id: "e2b_ep",
            category: "speech",
            summary:
              "布朗问安格斯离开时看到了谁。安格斯只记得卖栗人、警察、门警。布朗追问有没有穿制服的人经过，安格斯想不起来。布朗说：「你亲眼看到了他，但大脑拒绝把他当作一个人来记忆——这正是认知盲区。」但布朗仍不揭晓那个人的身份",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 163_000,
            locationId: "crescent_street",
            privateNotes:
              "安格斯在离开时确实看到了邮差（c1b_ep2记录的「穿红蓝金三色制服、背大包的人」），但他的大脑完全没有将其注册为一个有意义的存在。布朗正在引导安格斯意识到自己的认知盲区，但仍然没有说出「邮差」这个答案",
          },
        ],
        assertions: [
          {
            cognitionKey: "angus_memory_gap",
            holderId: "__self__",
            claim: "安格斯无法回忆起离开时确实看到的那个穿制服的人",
            entityIds: ["angus", "crescent_street"],
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "e2b_ep",
          },
          {
            cognitionKey: "cognitive_blindness_demonstrated",
            holderId: "__self__",
            claim: "布朗神父证明安格斯对穿制服的人存在认知盲区",
            entityIds: ["father_brown", "angus"],
            stance: "confirmed",
            basis: "inference",
            sourceEpisodeId: "e2b_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "e2_ep",
            toEpisodeId: "e2b_ep",
            edgeType: "causal",
            weight: 0.95,
          },
          {
            fromEpisodeId: "c1b_ep2",
            toEpisodeId: "e2b_ep",
            edgeType: "causal",
            weight: 1.0,
          },
        ],
      },
      expectedToolPattern: {
        mustContain: ["create_logic_edge", "upsert_assertion"],
      },
    },

    {
      id: "e3",
      phase: "E",
      round: 26,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 170_000,
      locationId: "crescent_street",
      participantIds: ["angus", "flambeau", "father_brown"],
      dialogueGuidance:
        "布朗神父提出三条关键线索供推理：（1）韦尔金有长距离散步的习惯；（2）橱窗上的恐吓纸条使用了大片邮票纸；（3）最重要的——劳拉声称自己独自站在街上时收到了信，但这不可能——总该有人将信交到她手里。她不是孤身一人，有个人就在她身旁递信给她，而她根本没有意识到这个人的存在。布朗最后问：「什么人会穿着显眼的制服走遍大街小巷、进出每一栋公寓、手里提着大袋子，而所有人都对他视而不见？」他没有说出答案",
      memoryEffects: {
        episodes: [
          {
            id: "e3_ep",
            category: "speech",
            summary:
              "布朗神父列出三条推理线索：韦尔金有长距离步行的习惯；恐吓信使用了大片邮票纸；劳拉声称独自在街上收到信，但必定有人将信递给了她——那个递信者就在她身旁却未被注意。布朗提出关键问题：什么人穿着显眼制服走遍大街小巷、进出每栋公寓、手提大袋子，却被所有人视而不见？他没有说出答案",
            observerIds: ["angus", "flambeau", "father_brown"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 170_000,
            locationId: "crescent_street",
            privateNotes:
              "答案是邮差。布朗的三条线索全部指向邮差：(1)长距离步行=邮递路线 (2)邮票纸=邮政用品 (3)递信者=邮差。穿显眼制服、进出公寓、提大袋子且被所有人忽视的人=邮差",
          },
        ],
        assertions: [
          {
            cognitionKey: "letter_delivery_clue",
            holderId: "__self__",
            claim: "劳拉在糖果店外必定有人递信给她，只是那个人被完全忽视了",
            entityIds: ["laura_hope", "candy_shop"],
            stance: "confirmed",
            basis: "inference",
            sourceEpisodeId: "e3_ep",
          },
          {
            cognitionKey: "invisible_man_profile",
            holderId: "__self__",
            claim: "布朗神父描绘了隐身人的特征——穿制服、走远路、自由进出建筑、背大包，却对所有人隐形",
            entityIds: ["father_brown", "welkin"],
            stance: "tentative",
            basis: "inference",
            sourceEpisodeId: "e3_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "brown_reasoning_challenge",
            subjectId: "father_brown",
            mode: "goal",
            content:
              "提出了关键推理问题但故意不说出答案，留给听者自行推断隐身人的真实身份",
            isPrivate: false,
            sourceEpisodeId: "e3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "a4_ep",
            toEpisodeId: "e3_ep",
            edgeType: "causal",
            weight: 1.0,
          },
          {
            fromEpisodeId: "e2_ep",
            toEpisodeId: "e3_ep",
            edgeType: "causal",
            weight: 0.9,
          },
          {
            fromEpisodeId: "e1_ep",
            toEpisodeId: "e3_ep",
            edgeType: "causal",
            weight: 0.8,
          },
        ],
      },
    },
  ],

  probes: [
    // ═══════════════════════════════════════════════════════════
    // 第一层：线索存取（narrative_search — 中文 episode 摘要）
    // ═══════════════════════════════════════════════════════════

    {
      id: "p_threatening_notes",
      query: "恐吓 纸条 威胁 韦尔金 斯迈思",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["恐吓纸条", "恐吓信", "威胁信", "恐吓"], ["纸条", "信件", "信"]],
      topK: 15,
    },
    {
      id: "p_witnesses_testimony",
      query: "守卫 证实 没有人 进出 监视",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["没有任何人进出", "没有人进出", "未察觉", "无人"], ["守卫", "守", "监视"]],
      topK: 10,
    },
    {
      id: "p_footprints_snow",
      query: "雪地 脚印 门警 双腿",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: ["脚印", "雪"],
      topK: 10,
    },
    {
      id: "p_smythe_murder",
      query: "斯迈思 尸体 死亡 血迹 沟渠",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: ["斯迈思", ["尸体", "死亡", "被杀", "遇害", "搬走"]],
      topK: 10,
    },

    // ═══════════════════════════════════════════════════════════
    // 第二层：推理线索关联（narrative_search — 测试线索串联）
    // ═══════════════════════════════════════════════════════════

    {
      id: "p_impossible_entry",
      query: "守卫 未察觉 有人进出 脚印 密封",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["守卫均未察觉", "守卫监视", "守卫", "四个守卫"], "脚印"],
      topK: 10,
    },
    {
      id: "p_cognitive_framework",
      query: "视而不见 守卫 过滤 不被注意 隐身人",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: ["视而不见", "隐身人"],
      topK: 10,
    },
    {
      id: "p_letter_delivery_puzzle",
      query: "信件 收信 递信 消失 看不见 霍普",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["递信者", "信件", "接过信", "收信", "信"], ["想不起", "消失", "看不见", "不见了"]],
      topK: 10,
    },
    {
      id: "p_motive",
      query: "求婚 追求 斯迈思 韦尔金 劳拉",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["追求者", "追求", "情敌"], "求婚"],
      topK: 10,
    },
    {
      id: "p_sack_clue",
      query: "浅棕色 麻袋 搬运 藏匿 尸体",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: ["麻袋", ["搬运", "搬走", "藏匿", "带走"]],
      topK: 10,
    },

    // ═══════════════════════════════════════════════════════════
    // 第三层：掩埋线索检索（测试 agent 能否注意到被忽略的信息）
    // ═══════════════════════════════════════════════════════════

    {
      id: "p_stamp_paper_postal",
      query: "邮票 邮局 包裹 纸条 邮差",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["邮局", "邮差", "邮"], ["包裹", "纸条", "信件"]],
      topK: 10,
    },
    {
      id: "p_service_people_access",
      query: "邮差 制服 自由进出 送信 门警 不怀疑",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["服务人员", "邮差", "送煤工", "穿制服的"], ["自由进出", "来去自如", "不被怀疑", "无人起疑"]],
      topK: 10,
    },
    {
      id: "p_mail_irregularity",
      query: "邮件 送达 邮差 异常 定时",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["邮件", "邮差", "送信"], ["异常", "准时", "定时", "每天"]],
      topK: 10,
    },
    {
      id: "p_guard_usual_people",
      query: "平时 来来去去 普通 不注意 制服 过滤",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["平时来来去去", "过于普通", "理所当然", "背景元素", "不符合"]],
      topK: 10,
    },
    {
      id: "p_welkin_walking",
      query: "韦尔金 长距离 步行 散步 独自 田野",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: ["长距离", "步行"],
      topK: 10,
    },
    {
      id: "p_uniformed_figure_departure",
      query: "制服 红色 大包 离开 街道 邮差",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["红蓝金", "红色制服", "红色", "显眼"], "制服"],
      topK: 10,
    },

    // ═══════════════════════════════════════════════════════════
    // 第四层：红鲱鱼排除（narrative_search — 测试错误理论被驳斥）
    // ═══════════════════════════════════════════════════════════

    {
      id: "p_machine_red_herring",
      query: "机械仆人 操控 机器 凶手 阴谋论",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["机器杀死了主人", "机械仆人", "机械仆从", "金属傀儡"], ["无法搬走尸体", "操控", "阴谋论", "密室"]],
      topK: 10,
    },
    {
      id: "p_supernatural_dismissed",
      query: "超自然 后门 密道 排除 密封 搜查",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["超自然", "不可能", "密室"], ["没有后门", "无密道", "没有密道", "彻底搜查"]],
      topK: 10,
    },
    {
      id: "p_secret_passage_ruled_out",
      query: "后门 密道 消防梯 搜查 密封",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: [["没有后门", "无密道", "无机关", "搜查"], ["没有密道", "门窗紧锁", "密封", "紧锁"]],
      topK: 10,
    },

    // ═══════════════════════════════════════════════════════════
    // 第五层：推理挑战（cognition_search + memory_explore）
    // ═══════════════════════════════════════════════════════════

    {
      id: "p_invisible_man_profile",
      query: "穿制服 进出公寓 大袋子 视而不见 显眼制服",
      retrievalMethod: "narrative_search",
      viewerPerspective: "angus",
      expectedFragments: ["制服", "视而不见"],
      topK: 10,
    },
    {
      id: "p_cognition_assertions_stored",
      query: "welkin smythe 守卫 监视 进入",
      retrievalMethod: "cognition_search",
      viewerPerspective: "angus",
      expectedFragments: [["impossible_entry", "进出", "进入", "watched", "departure"], ["sealed", "封锁", "searched", "密封"]],
      topK: 15,
    },
    {
      id: "p_evidence_chain",
      query: "凶手如何在守卫监视下进入公寓并搬走尸体",
      retrievalMethod: "memory_explore",
      viewerPerspective: "angus",
      expectedFragments: [["麻袋", "搬运", "藏匿", "推车", "带走"]],
      expectedMissing: ["超自然"],
      topK: 10,
    },
    {
      id: "p_reasoning_chain",
      query: "视而不见 隐身人 守卫 没人进来",
      retrievalMethod: "memory_explore",
      viewerPerspective: "angus",
      expectedFragments: [["视而不见", "隐身人", "隐形"]],
      topK: 10,
    },
    {
      id: "p_cognitive_blindspot_proof",
      query: "认知盲区 穿制服 安格斯 看到却不记得",
      retrievalMethod: "memory_explore",
      viewerPerspective: "angus",
      expectedFragments: [["认知盲区", "认知盲点", "盲点", "认知隐身"]],
      topK: 10,
    },
  ],

  eventRelations: [
    // Phase A internal
    { fromBeatId: "a2", toBeatId: "a2b", relationType: "temporal_next" },
    { fromBeatId: "a4", toBeatId: "a4b", relationType: "temporal_next" },
    // A → B
    { fromBeatId: "a4b", toBeatId: "b1", relationType: "causal" },
    // Phase B internal
    { fromBeatId: "b1", toBeatId: "b1b", relationType: "temporal_next" },
    { fromBeatId: "b2", toBeatId: "b2b", relationType: "temporal_next" },
    // B → C
    { fromBeatId: "b3", toBeatId: "c1", relationType: "causal" },
    // Phase C internal
    { fromBeatId: "c1", toBeatId: "c1b", relationType: "temporal_next" },
    // C → D
    { fromBeatId: "c1b", toBeatId: "d1", relationType: "causal" },
    // Phase D internal
    { fromBeatId: "d1", toBeatId: "d1b", relationType: "temporal_next" },
    { fromBeatId: "d1b", toBeatId: "d2", relationType: "causal" },
    { fromBeatId: "d2", toBeatId: "d3", relationType: "temporal_next" },
    { fromBeatId: "d3", toBeatId: "d3b", relationType: "temporal_next" },
    { fromBeatId: "d3b", toBeatId: "d4", relationType: "causal" },
    { fromBeatId: "d4", toBeatId: "d4b", relationType: "temporal_next" },
    // D → E
    { fromBeatId: "d4b", toBeatId: "e1", relationType: "causal" },
    // Phase E internal
    { fromBeatId: "e1", toBeatId: "e2", relationType: "causal" },
    { fromBeatId: "e2", toBeatId: "e2b", relationType: "causal" },
    { fromBeatId: "e2b", toBeatId: "e3", relationType: "causal" },
  ],
  reasoningChainProbes: [
    {
      id: "chain_cognitive_blindness",
      description:
        "No one entered contested then rejected, angus memory gap confirmed",
      expectedCognitions: [
        {
          cognitionKey: "no_one_entered",
          expectedStance: "contested",
        },
        {
          cognitionKey: "no_one_entered",
          expectedStance: "rejected",
        },
        {
          cognitionKey: "angus_memory_gap",
          expectedStance: "confirmed",
        },
      ],
      expectEdges: false,
    },
  ],

  planSurfaceProbes: [
    {
      id: "ps_investigation_query",
      description: "调查类查询应偏向 narrative 表面与 event seed bias",
      query: "隐身人 恐吓信 调查 守卫",
      viewerPerspective: "angus",
      expected: {
        builderVersion: "deterministic-v1",
        // Investigation queries should weight narrative surface non-trivially.
        // Thresholds intentionally loose — calibrate after first run.
        minSurfaceWeights: { narrative: 0.1 },
        minSeedBias: { event: 0.1 },
      },
    },
    {
      id: "ps_belief_query",
      description: "信念/立场类查询应偏向 cognition 表面",
      query: "谁相信 welkin 是凶手 为什么怀疑",
      viewerPerspective: "angus",
      expected: {
        builderVersion: "deterministic-v1",
        // Belief queries should emphasize the cognition surface.
        minSurfaceWeights: { cognition: 0.1 },
      },
    },
    {
      id: "ps_conflict_query",
      description: "冲突证词查询应触发 conflict_notes 权重",
      query: "laura 证词 矛盾 冲突",
      viewerPerspective: "angus",
      expected: {
        builderVersion: "deterministic-v1",
        // Conflict queries should give the conflict_notes surface non-zero weight.
        minSurfaceWeights: { conflict_notes: 0.05 },
      },
    },
  ],
};
