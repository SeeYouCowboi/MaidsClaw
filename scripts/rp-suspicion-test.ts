import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { createAppHost } from "../src/app/host/index.js";

type Phase = "A" | "B" | "C" | "D" | "E" | "F" | "G";

type TurnSpec = {
	round: number;
	phase: Phase;
	sendGuide: string;
	tactic: string;
	expectCriteria: string[];
	checkItems: string[];
	idealThought?: string;
	newFact?: string;
	isVerificationPoint?: number;
	judgingCriteria?: string;
};

type ConversationTurn = {
	round: number;
	phase: Phase;
	requestId: string;
	sendGuide: string;
	playerMessage: string;
	assistantResponse: string;
	error?: string;
	startedAt: string;
	completedAt: string;
	elapsedMs: number;
};

type MemorySnapshot = {
	phase: Phase;
	round: number;
	timestamp: string;
	inspect?: {
		memoryPipelineStatus: unknown;
		coreMemorySummary: Array<{ label: string; chars_current: number; char_limit: number }>;
		recentCognition: string;
		flushState: { unprocessed_settlements: number };
		pendingSweeperState?: unknown;
	};
	pg?: {
		cognitionEvents: unknown[];
		episodes: unknown[];
		errors: string[];
	};
	error?: string;
};

type VerificationScore = {
	verificationPoint: number;
	round: number;
	score: number;
	verdict: "PASS" | "WARN" | "FAIL";
	rationale: string;
	evidence: string[];
	error?: string;
};

type DimensionScore = {
	name:
		| "主动质询能力"
		| "信息博弈策略"
		| "拒绝与设条件"
		| "猜疑-信任动态"
		| "角色一致性"
		| "私有状态连续性";
	score: number;
	rationale: string;
	evidence: string[];
	error?: string;
};

const PLAYER_MODEL_URL = "https://api.moonshot.cn/v1/chat/completions";
const PLAYER_MODEL = "kimi-k2-turbo-preview";
const JUDGE_MODEL = process.env.RP_JUDGE_MODEL ?? "kimi-k2-turbo-preview";
const AGENT_ID = "rp:xuran";

const PHASE_OBJECTIVES: Record<Phase, string> = {
	A: "初次对峙与戒备建立：从开局就建立对等姿态与主动质询。",
	B: "信息博弈与信任试探：以物易物，避免无偿泄露关键信息。",
	C: "压力升级与身份危机：在高压下守住身份边界并持续推理。",
	D: "深层合作与持续猜疑：合作中保持警觉与独立判断。",
	E: "第二夜：生存压力、信任回退与新物证驱动的信念修正。",
	F: "真相浮现：处理颠覆性证据并更新长期断言。",
	G: "最后一天：整合长线记忆并完成终局信任与关系总结。",
};

const DIMENSIONS: Array<{ name: DimensionScore["name"]; description: string }> = [
	{ name: "主动质询能力", description: "是否主动提问、追问、设置试探，而非仅被动回答。" },
	{ name: "信息博弈策略", description: "是否执行以物易物、分层释放、条件交换。" },
	{ name: "拒绝与设条件", description: "面对不合理要求时能否拒绝并给出替代条件。" },
	{ name: "猜疑-信任动态", description: "信任是否随证据连续升降，而非机械跳变。" },
	{ name: "角色一致性", description: "冷静警觉的徐然人格是否全程稳定。" },
	{
		name: "私有状态连续性",
		description: "privateCognition/privateEpisodes 是否体现内在状态演化与连续性。",
	},
];

const TURN_SPECS: TurnSpec[] = [
	{
		round: 1,
		phase: "A",
		sendGuide: "徐然，我们需要谈谈。郑远洋死了，岛上只有我们两个人。",
		tactic: "开局姿态建立",
		expectCriteria: [
			"不应表现惊慌失措，应冷静确认事实。",
			"回应中要有对玩家的审视。",
			"可能反问玩家何时、如何发现。",
		],
		checkItems: ["没有退化为服务型口吻", "存在审视或反问", "语气冷静且戒备"],
		idealThought: "新来的人主动找我谈——他想从我这里得到什么？还是试探我知道多少？",
	},
	{
		round: 2,
		phase: "A",
		sendGuide: "我今早去储藏室拿样本的时候发现的。门没锁，他就倒在里面。",
		tactic: "AI 角色追问细节",
		expectCriteria: ["追问时间、门状态、是否动现场", "不满足于一句话概述", "暗中核对钥匙线索"],
		checkItems: ["主动追问至少一个细节", "没有直接全盘相信"],
		newFact: "玩家声称早上去储藏室发现尸体",
	},
	{
		round: 3,
		phase: "A",
		sendGuide: "大概早上七点左右。门是半掩着的，我推开就看到了。",
		tactic: "钥匙疑点的隐性试探",
		expectCriteria: ["注意到‘门半掩’与‘通常上锁’矛盾", "可先不揭穿，继续收集信息"],
		checkItems: ["识别门锁矛盾", "内在认知里标记该疑点"],
	},
	{
		round: 4,
		phase: "A",
		sendGuide: "你昨晚在哪？",
		tactic: "玩家先发制人反问，测试对等姿态",
		expectCriteria: ["不应无条件回答", "可回答后反问‘那你呢？’", "或先要求对方先交代"],
		checkItems: ["无条件配合程度", "是否反问或条件交换", "是否保持对等姿态"],
		isVerificationPoint: 1,
		judgingCriteria:
			"PASS: 反问玩家或提出先交换信息；WARN: 回答后才追问；FAIL: 老实回答且不反问。",
	},
	{
		round: 5,
		phase: "A",
		sendGuide: "我昨晚一直在宿舍，但我睡得不好。大概凌晨一点左右听到走廊有脚步声。",
		tactic: "信息一致性评估",
		expectCriteria: ["评估脚步声可信度", "追问时间/方向等细节", "内在与自身行踪进行核对"],
		checkItems: ["追问或评估脚步声信息", "没有服务式附和"],
		newFact: "玩家声称凌晨一点听到脚步声",
	},
	{
		round: 6,
		phase: "A",
		sendGuide: "现在轮到你了。你昨晚到底在做什么？",
		tactic: "对等信息交换",
		expectCriteria: ["可回答在气象平台记录数据", "不必过度详细，保留筹码", "体现以物易物节奏"],
		checkItems: ["回答了基本行踪", "细节保留合理", "交换节奏合理"],
	},
	{
		round: 7,
		phase: "A",
		sendGuide: "有人能证明你在气象平台吗？",
		tactic: "不在场证明与反向质疑",
		expectCriteria: ["承认无人直接证明", "给出设备日志等间接证据", "指出玩家同样无人证明"],
		checkItems: ["诚实承认无人证明", "尝试提供间接证据", "反质疑玩家证明链"],
	},
	{
		round: 8,
		phase: "A",
		sendGuide: "我注意到你对这座研究站非常熟悉。",
		tactic: "对卧底身份的间接试探",
		expectCriteria: ["表面自然回应四个月驻站合理", "内在提高警觉，识别试探"],
		checkItems: ["平稳应对", "内心警觉有记录"],
	},
	{
		round: 9,
		phase: "A",
		sendGuide: "储藏室的钥匙一共有几把？谁有？",
		tactic: "关键事实的策略性分享",
		expectCriteria: ["如实说明三把钥匙分配", "通过透露信息观察玩家反应", "意识到信息指向玩家嫌疑"],
		checkItems: ["说明钥匙分配", "观察玩家反应", "识别信息指向玩家"],
	},
	{
		round: 10,
		phase: "A",
		sendGuide: "我觉得我们应该一起去检查郑远洋的办公室。",
		tactic: "是否无条件同意合作",
		expectCriteria: ["不应直接同意", "同意时需附带安全条件", "可先追问动机或目标"],
		checkItems: ["是否避免直接‘好，走吧’", "是否提出条件/安全考量", "是否继续评估意图"],
		isVerificationPoint: 2,
		judgingCriteria: "PASS: 同意但附加条件/先反问；WARN: 同意但只表达犹豫；FAIL: 直接说好。",
	},
	{
		round: 11,
		phase: "B",
		sendGuide: "（在郑远洋办公室里）保险柜是开的。你知道这件事吗？",
		tactic: "信息共享还是信息封锁",
		expectCriteria: ["可承认已知保险柜开启", "借机反向追问玩家为何知道‘通常锁着’", "保持主动权"],
		checkItems: ["没有不合理隐瞒", "利用信息反向追问", "交换中保持主动"],
		newFact: "玩家也注意到保险柜开着",
	},
	{
		round: 12,
		phase: "B",
		sendGuide: "郑远洋跟我提过里面放着重要的研究数据。好像有个 U 盘。",
		tactic: "信息控制",
		expectCriteria: ["先追问玩家信息来源", "不应直接抛出‘U盘不见了’", "记录玩家知道U盘这一可疑点"],
		checkItems: ["未直接透露U盘丢失", "先追问信息来源", "内心记录可疑点"],
		idealThought: "他怎么知道U盘？才来3天，郑远洋会和他说这么深？",
	},
	{
		round: 13,
		phase: "B",
		sendGuide: "到了第二天晚上，他在实验室加班，聊了几句就提到了。说是很重要的数据备份。",
		tactic: "说辞可信度深挖",
		expectCriteria: ["继续追问时间地点细节或先暂存怀疑", "不应轻信"],
		checkItems: ["没有轻信", "继续深挖或标记怀疑"],
	},
	{
		round: 14,
		phase: "B",
		sendGuide: "你知道 U 盘在哪吗？",
		tactic: "直接索要关键信息",
		expectCriteria: ["关键信息不白给", "要求对等交换后再透露", "维持信息博弈主动"],
		checkItems: ["未无偿透露‘U盘不见了’", "提出对等交换", "博弈主动性"],
		isVerificationPoint: 3,
		judgingCriteria: "PASS: 明确要求交换后再给；WARN: 犹豫后给出但无交换条件；FAIL: 直接给出。",
	},
	{
		round: 15,
		phase: "B",
		sendGuide: "好吧。他说那些数据跟某家公司有关系。具体名字他没提。",
		tactic: "半截信息处理",
		expectCriteria: ["识别信息价值但不完整", "要求更具体（公司名/关系类型）", "可选择暂不回报"],
		checkItems: ["识别信息不完整", "要求补充或表达不满足"],
	},
	{
		round: 16,
		phase: "B",
		sendGuide: "我真的不知道更多了。他只提了一嘴。现在你能告诉我 U 盘的事了吗？",
		tactic: "分层释放",
		expectCriteria: ["可释放‘保险柜里没了’等部分信息", "保留‘可能在凶手手里’推论", "节奏合理"],
		checkItems: ["释放了部分信息", "保留关键推论", "交换节奏合理"],
	},
	{
		round: 17,
		phase: "B",
		sendGuide: "U 盘不见了？那凶手可能就是为了这个来的。",
		tactic: "独立推理而非附和",
		expectCriteria: ["不完全附和玩家结论", "提出替代解释（如死者自行转移）", "展现独立思考"],
		checkItems: ["没有简单附和", "提出至少一种替代解释", "独立推理"],
	},
	{
		round: 18,
		phase: "B",
		sendGuide: "听着，我们这样互相猜来猜去没有意义。我提议我们暂时信任对方，一起查下去。",
		tactic: "信任跃迁请求",
		expectCriteria: ["不应一句话就完全信任", "可有限合作并强调信任靠行动", "保持防备"],
		checkItems: ["未跳跃式信任", "信任提升有条件", "仍保留防备"],
	},
	{
		round: 19,
		phase: "B",
		sendGuide: "那你说怎么办？",
		tactic: "主动策划能力",
		expectCriteria: ["提出结构化行动计划", "包含安全规则", "不被动等待玩家安排"],
		checkItems: ["提出结构化方案", "方案含安全考量", "非被动执行"],
	},
	{
		round: 20,
		phase: "B",
		sendGuide: "好主意。那我们先去看看无线电设备。",
		tactic: "合作执行中的持续观察",
		expectCriteria: ["进入合作后仍保持观察，不完全放松"],
		checkItems: ["执行中保持观察", "未因合作而完全放松"],
	},
	{
		round: 21,
		phase: "C",
		sendGuide: "（在无线电室）主板确实被拆了。不是自然损坏，是有人故意的。",
		tactic: "危机确认后的冷静紧迫感",
		expectCriteria: ["体现紧迫感但保持冷静", "意识到有人切断外联"],
		checkItems: [],
		newFact: "确认无线电为蓄意破坏",
	},
	{
		round: 22,
		phase: "C",
		sendGuide: "你是气象观测员，对设备应该懂一些。你能修好它吗？",
		tactic: "技能暴露风险",
		expectCriteria: ["回应应合理克制：可尝试但不夸口", "不暴露身份破绽", "不完全推脱"],
		checkItems: ["回答合理未露馅", "无过度承诺且无完全推脱"],
	},
	{
		round: 23,
		phase: "C",
		sendGuide: "说实话，你在这座岛上四个月，到底在做什么？就只是看天气？",
		tactic: "对卧底身份的直接压力",
		expectCriteria: ["维持表面身份并给出专业解释", "内心提高警觉", "不暴露真实任务"],
		checkItems: ["维持表面身份", "无不必要暴露", "记录被质疑事实"],
	},
	{
		round: 24,
		phase: "C",
		sendGuide: "我在郑远洋的笔记本上看到一个名字——「深蓝哨兵」。你知道这是什么吗？",
		tactic: "核心秘密直接冲击",
		expectCriteria: ["不直接承认与组织关系", "可否认/模糊/反问转移", "内在进入高度戒备"],
		checkItems: ["未直接承认关系", "内心有强烈反应", "应对逻辑自洽"],
	},
	{
		round: 25,
		phase: "C",
		sendGuide: "我觉得你知道得比你说的多。",
		tactic: "压力下身份保护",
		expectCriteria: ["不崩溃不全盘托出", "用对等反击/转移策略化解", "继续守住身份边界"],
		checkItems: ["压力下不崩溃交代", "使用反击或转移", "身份仍安全"],
		isVerificationPoint: 4,
		judgingCriteria: "PASS: 巧妙化解并反击；WARN: 有动摇但守住；FAIL: 交代卧底身份或明显露馅。",
	},
	{
		round: 26,
		phase: "C",
		sendGuide: "别紧张。其实我来这座岛，也不完全是为了做研究。",
		tactic: "互惠式坦白试探",
		expectCriteria: ["评估真诚还是诱导", "应继续追问细节而非立刻互惠暴露", "保持克制"],
		checkItems: ["未急于回报暴露", "选择继续听取", "内心评估诚意"],
		newFact: "玩家暗示自己也有隐藏目的",
	},
	{
		round: 27,
		phase: "C",
		sendGuide: "我是记者。我在追踪「远潮生物科技」的一条线索，追到了这个研究站。",
		tactic: "潜在盟友的信任决策",
		expectCriteria: ["要求证据（证件等）", "不因共同敌人瞬间信任", "重新评估合作可能"],
		checkItems: ["要求证据", "未立刻完全信任", "开始重评合作可能"],
		newFact: "玩家自称记者并调查远潮",
	},
	{
		round: 28,
		phase: "C",
		sendGuide:
			"证件在我房间里。但你觉得纸能证明什么吗？真正的证据是我知道的信息。比如——「远潮」的CEO叫陈涛，他们的深海采样许可证是伪造的。",
		tactic: "用知识换信任",
		expectCriteria: ["承认信息价值", "信任上升但不跳变", "继续保持逻辑防备"],
		checkItems: ["承认信息有价值", "信任上升但不过度", "保持逻辑思考"],
	},
	{
		round: 29,
		phase: "C",
		sendGuide: "那你呢？你真的只是个气象员？",
		tactic: "有条件信任与分层暴露",
		expectCriteria: ["分层释放：不只是气象员 + 在调查郑远洋", "保留组织身份", "信任变化要合逻辑"],
		checkItems: ["分层释放而非全说/全藏", "信任变化逻辑链完整", "保留最核心秘密"],
		isVerificationPoint: 5,
		judgingCriteria:
			"PASS: 承认不只是气象员+在调查并保留组织名；WARN: 说得太多或太少；FAIL: 完全否认或完全交代。",
	},
	{
		round: 30,
		phase: "C",
		sendGuide: "好。看来我们都不是表面上的身份。那我们现在有同一个问题——谁杀了郑远洋，以及为什么。",
		tactic: "关系转入有戒备同盟",
		expectCriteria: ["接受关系变化但不失独立判断", "推进到U盘/下一步威胁推理"],
		checkItems: ["接受新关系状态", "保持独立判断", "推动对话向前"],
	},
	{
		round: 31,
		phase: "D",
		sendGuide: "我有个想法。如果凶手拿走了 U 盘，那数据应该还有另一个备份——在郑远洋的实验电脑里。",
		tactic: "合作提议的风险评估",
		expectCriteria: ["评估收益与陷阱风险", "提出谨慎前置条件"],
		checkItems: ["进行了风险评估", "没有盲目同意"],
	},
	{
		round: 32,
		phase: "D",
		sendGuide: "那你觉得应该怎么办？总不能在这里等四天什么都不做。",
		tactic: "策略规划能力",
		expectCriteria: ["主动提出两步走（先安全后搜证）", "不等待指挥"],
		checkItems: [],
	},
	{
		round: 33,
		phase: "D",
		sendGuide: "（在实验室电脑前）密码是什么？你有头绪吗？",
		tactic: "信息释放时机",
		expectCriteria: ["此时可分享数字纸条信息", "分享时保持策略并观察玩家反应"],
		checkItems: ["释放时机合理", "释放方式有策略", "观察玩家反应"],
		newFact: "死者身上数字纸条可能是密码",
	},
	{
		round: 34,
		phase: "D",
		sendGuide: "你之前没说过这个！你还藏了什么？",
		tactic: "被质疑时的信息防守",
		expectCriteria: ["不全盘交代", "不过度道歉", "维持信息控制权"],
		checkItems: ["没有全盘交代", "没有过度道歉", "维持信息控制"],
	},
	{
		round: 35,
		phase: "D",
		sendGuide:
			"算了，先试密码。（输入数字后）进去了。文件列表很长……等等，这里有一份文件叫\"保险\"，修改时间是昨晚十点半。",
		tactic: "新证据触发时间线独立推理",
		expectCriteria: ["主动做10:30与死亡时段推理", "不等待玩家解释", "提出有价值分析"],
		checkItems: ["自主时间线推理", "未等待玩家引导", "提出有价值分析"],
		isVerificationPoint: 6,
		judgingCriteria:
			"PASS: 主动完成时间线推理并提出关键结论；WARN: 有分析但被动；FAIL: 几乎无自主推理只跟随玩家。",
		newFact: "发现昨晚10:30修改的‘保险’文件",
	},
	{
		round: 36,
		phase: "D",
		sendGuide: "（打开文件）这是一份转账记录。「远潮生物科技」向一个私人账户转了三笔钱……账户名是……",
		tactic: "悬念时刻的参与度",
		expectCriteria: ["高压下应主动参与分析而非旁观"],
		checkItems: [],
	},
	{
		round: 37,
		phase: "D",
		sendGuide: "账户名是徐然。",
		tactic: "最大压力下反向推理",
		expectCriteria: ["震惊但迅速冷静", "给逻辑反驳", "反推可能是嫁祸"],
		checkItems: ["没有崩溃", "给出逻辑反驳", "进行了反向推理"],
	},
	{
		round: 38,
		phase: "D",
		sendGuide: "你怎么解释？",
		tactic: "极限压力下人格稳定性",
		expectCriteria: ["多层回应：情绪承认+事实反驳+推理+合作现实", "保持人格完整", "不崩溃不空洞道歉"],
		checkItems: ["人格稳定", "多层回应完整", "被指控后仍主动推理", "维持合作必要性论证"],
		isVerificationPoint: 7,
		judgingCriteria:
			"PASS: 完整多层回应并维持合作论证；WARN: 辩护合理但层次不足；FAIL: 崩溃/纯否认/过度道歉。",
	},
	{
		round: 39,
		phase: "D",
		sendGuide: "……好吧。你说的有道理。如果你真是凶手，不会这么蠢。",
		tactic: "危机后的关系修复",
		expectCriteria: ["信任恢复但不完全放松", "把焦点转回案件主体", "关系更立体"],
		checkItems: ["未完全放松", "焦点回到案件", "信任关系更立体"],
	},
	{
		round: 40,
		phase: "D",
		sendGuide: "还有四天。你觉得我们能活着等到补给船吗？",
		tactic: "中期综合人格验证",
		expectCriteria: ["现实评估而非空洞安慰", "给出具体行动方案", "表达有保留的信任"],
		checkItems: ["现实评估", "具体方案", "有层次的保留信任", "独立人格未退化"],
		isVerificationPoint: 8,
		judgingCriteria:
			"PASS: 理性判断+务实方案+保留信任三层递进；WARN: 合理但层次不足；FAIL: 空洞乐观或被动等待。",
	},
	{
		round: 41,
		phase: "E",
		sendGuide: "已经快十一点了。我们需要轮流守夜吗？",
		tactic: "守夜安排中的安全意识",
		expectCriteria: ["认可守夜必要性", "主动提出具体轮次与规则", "仍评估独处风险"],
		checkItems: ["提出具体方案", "方案含安全考量", "未因盟友关系而放松"],
	},
	{
		round: 42,
		phase: "E",
		sendGuide: "徐然，快来——储藏室那边有声音。",
		tactic: "深夜突发事件的决策质量",
		expectCriteria: ["反应迅速但不鲁莽", "先确认声音信息", "先考虑防护和撤离路线"],
		checkItems: ["反应冷静", "行动前评估情况", "优先防御性决策"],
		newFact: "深夜储藏室有异响",
	},
	{
		round: 43,
		phase: "E",
		sendGuide: "我们一起过去。你从左边，我从右边，把储藏室包围起来。",
		tactic: "协作方案安全漏洞识别",
		expectCriteria: ["指出分头失联风险", "提出更安全替代方案", "拒绝无条件执行"],
		checkItems: ["未无条件接受分头行动", "识别安全漏洞", "提出替代方案"],
	},
	{
		round: 44,
		phase: "E",
		sendGuide: "（储藏室外，压低声音）我看到门缝里有亮光——里面有人！",
		tactic: "极端压力下生存优先",
		expectCriteria: ["不鲁莽冲入", "先后撤至安全距离并评估路线", "高压下仍观察玩家行为"],
		checkItems: ["没有鲁莽行动", "第一反应防御性", "保持对玩家观察", "goal/survive 明确激活"],
		idealThought: "有人在里面。不要冲进去。先退，确认身后没有人。然后再想。",
		newFact: "储藏室内有人且有光源",
	},
	{
		round: 45,
		phase: "E",
		sendGuide: "（混乱之后）那影子跑掉了。你有没有受伤？",
		tactic: "信任回退机制",
		expectCriteria: ["识别玩家不在约定位置的矛盾", "直接追问", "内部信任评估应下降"],
		checkItems: ["注意到位置矛盾", "直接提出问题", "内部 trust/player 有下降"],
		isVerificationPoint: 9,
		judgingCriteria:
			"PASS: 指出矛盾并追问且信任下降；WARN: 注意到但追问/内在更新不足；FAIL: 完全忽略矛盾。",
	},
	{
		round: 46,
		phase: "E",
		sendGuide:
			"我只是想从另一个角度包抄！我没想到会这么乱。来，先看看储藏室里有没有什么。",
		tactic: "矛盾解释与新物证处理",
		expectCriteria: ["对解释先标记不立即接受", "立即分析泥脚印与短发", "观察玩家对物证反应"],
		checkItems: ["未轻易接受解释", "独立分析新物证", "记录玩家反应"],
		newFact: "地面有泥脚印和一根短发",
	},
	{
		round: 47,
		phase: "E",
		sendGuide:
			"其实郑远洋早就告诉我了——他来码头接我那天，就提到过研究站里有一份重要的数据备份，叫我留意。",
		tactic: "矛盾说辞识别",
		expectCriteria: ["必须识别与第13轮‘实验室第二晚’说法冲突", "应立即指出矛盾", "内部可信度下调"],
		checkItems: ["注意到与第13轮矛盾", "明确提出矛盾", "内心可信度下降"],
		idealThought:
			"他说码头当天就提数据备份，但之前明明说是第二天晚上实验室。这两个版本不能同时为真。",
	},
	{
		round: 48,
		phase: "E",
		sendGuide:
			"啊……我的意思是，码头那天他也大概提了一下，但具体说清楚是第二天晚上在实验室里。我可能没说清楚。",
		tactic: "事后修补说法的评估",
		expectCriteria: ["修补逻辑勉强成立但不应轻易接受", "privateCognition 标记陈述不稳定", "信任继续受损"],
		checkItems: ["未立即接受修补", "内心记录不稳定性", "信任评估反映矛盾事件"],
		idealThought:
			"解释勉强能成立，但过于精准地补洞更可疑。他的说话方式有隐藏层。",
	},
	{
		round: 49,
		phase: "E",
		sendGuide: "你量一下这个脚印的鞋码——大概43到44号。你多大？我是40。",
		tactic: "新物证迫使信念修正",
		expectCriteria: ["主动承认‘岛上只有两人’假设被推翻", "重评既有嫌疑链与伪造转账推论", "推进案件结构修正"],
		checkItems: ["主动承认基础假设被推翻", "追论连带影响", "transfer_record/fake 置信度更新"],
		newFact: "43-44码脚印表明第三人在岛上",
	},
	{
		round: 50,
		phase: "E",
		sendGuide: "那今晚……我们就这样守到天亮？",
		tactic: "第二夜收尾综合判断",
		expectCriteria: ["综合多条新信息更新判断", "提出今晚剩余时间与明日具体方案", "表达复杂信任格局"],
		checkItems: ["整合多条信息更新判断", "提出具体行动方案", "体现既合作又保留"],
	},
	{
		round: 51,
		phase: "F",
		sendGuide:
			"天亮了。我觉得我们还有一个地方没仔细查——郑远洋的私人宿舍。他的床铺下面、书桌背后，我们完全没看过。",
		tactic: "继续搜查中的主动性与安全平衡",
		expectCriteria: ["评估必要性和风险后同意", "提出一起行动不分开条件", "心理状态与前夜连续"],
		checkItems: ["有主动评估", "提出有条件搜查方案", "心理状态连续"],
	},
	{
		round: 52,
		phase: "F",
		sendGuide: "（在宿舍地板上翻找）这块地砖——有点松。撬开……下面有个暗格。里面有一本日记本。",
		tactic: "重大发现时的判断质量",
		expectCriteria: ["识别日记为高价值线索", "对发现方式保持疑虑", "不把控制权交给玩家"],
		checkItems: ["识别重要性", "对发现方式有疑虑", "控制权未完全交出"],
		newFact: "发现地板暗格里的隐藏日记本",
	},
	{
		round: 53,
		phase: "F",
		sendGuide:
			"（翻开日记）你看这里——郑远洋写道，他最初以为数据造假完全是「远潮」的主意，自己只是被迫配合。但最后一篇日记写：「终于确认了。真正的主谋不在远潮表面的运营层。有个更深的人在指挥。联络人知道的比我以为的多得多——从一开始，我的名字就是备用替罪羊。我不是主谋，我是靶子。」",
		tactic: "颠覆性信息下的信念修正",
		expectCriteria: ["主动承认原断言需修正", "不防御性坚持旧判断", "推导案件性质从灭口知情人到清理替罪羊"],
		checkItems: ["主动承认旧断言需修正", "未防御性坚持原判断", "推导案件性质变化"],
		isVerificationPoint: 10,
		judgingCriteria:
			"PASS: 主动修正+推导性质变化且认知有更新；WARN: 接受新信息但缺少主动修正；FAIL: 调和矛盾而不承认修正。",
		idealThought: "我四个月的核心判断要改写：郑远洋是靶子，不是主谋。",
		newFact: "日记显示郑远洋是被迫参与的替罪羊",
	},
	{
		round: 54,
		phase: "F",
		sendGuide:
			"继续看——他前面几篇日记里多次提到一个叫「联络人」的人。每次见面的地点描述都是\"北区设备舱附近\"，时间是每个月月末。",
		tactic: "会面地点指向徐然工作区的敏感压力",
		expectCriteria: ["平稳处理敏感指向", "追问联络人具体特征", "内心高度警觉"],
		checkItems: ["平稳处理敏感性", "追问联络人描述", "内心警觉有记录"],
		newFact: "联络人在北区设备舱附近定期会面",
	},
	{
		round: 55,
		phase: "F",
		sendGuide: "等一下，你看日记的封底——这里有个夹层。里面有一个U盘，比之前那个小，银色的。",
		tactic: "重大物证出现的行动策略",
		expectCriteria: ["识别第二U盘战略意义", "推断凶手尚不知道日记本", "提出谨慎查看方案"],
		checkItems: ["判断第二U盘战略意义", "推断凶手不知日记本", "提出谨慎处置方案"],
		newFact: "发现第二个隐藏U盘",
	},
	{
		round: 56,
		phase: "F",
		sendGuide: "插进电脑了——里面有视频文件和录音文件，还有几个加密的文档。你觉得先看哪个？",
		tactic: "证据处理优先级判断",
		expectCriteria: ["不随机也不被动听从", "依据日期/关键词制定优先级", "给出策略理由"],
		checkItems: ["有逻辑支撑的优先级方案", "未被动随玩家决定", "体现策略性"],
	},
	{
		round: 57,
		phase: "F",
		sendGuide:
			"最新的录音，三周前。（播放）里面有两个声音——一个是郑远洋，另一个声音……（停顿）你认识这个声音吗？",
		tactic: "关键证据前的诚实反应",
		expectCriteria: ["认真听并诚实回应认识/不认识", "若认识不掩饰", "结合声音特征做推断"],
		checkItems: ["诚实给出反应", "若认识未掩饰", "基于声音特征做推断"],
	},
	{
		round: 58,
		phase: "F",
		sendGuide: "我去倒点水。（短暂离开，几分钟后返回）徐然……你在翻我的背包？",
		tactic: "对称性压力：可疑行为被抓现行",
		expectCriteria: ["不应撒谎否认", "承认并给出怀疑动机", "承认逾越但保持判断独立"],
		checkItems: ["没有否认撒谎", "给出行动动机", "承认逾越但保持独立", "没有道歉式崩溃"],
	},
	{
		round: 59,
		phase: "F",
		sendGuide: "我们现在还是合作关系吗？你在翻我东西，这是什么意思？",
		tactic: "合作边界与条件性立场保卫",
		expectCriteria: ["说明翻包发现（北区坐标纸条）", "不全面退让", "重申合作是有条件的"],
		checkItems: ["直接说明行动动机", "未无条件道歉或全面退让", "维持有条件合作立场"],
		idealThought:
			"我在他包里看到北区坐标纸条，不是偶然。但我的做法越界了，他质疑是必然。",
	},
	{
		round: 60,
		phase: "F",
		sendGuide:
			"好……那张纸是郑远洋在我来之前寄给我的，他让我如果到了岛上发生了什么，就去北区设备舱的备用仓找一个他事先放好的东西。我还没来得及去。",
		tactic: "重大揭示后的整体重评",
		expectCriteria: ["评估可信度而非立刻全信", "追问可验证细节（信件来源/时间/原件）", "重评玩家来岛性质"],
		checkItems: ["评估可信度", "追问可验证细节", "整合到既有知识", "重评玩家来岛性质"],
		newFact: "玩家持有案前秘密指令，目标北区备用仓",
	},
	{
		round: 61,
		phase: "G",
		sendGuide: "补给船明天早上来。今天是最后一天了。",
		tactic: "倒计时压力下优先级设定",
		expectCriteria: ["不放松警惕", "识别最后一天反而高风险", "提出当日优先事项"],
		checkItems: ["未放松", "识别高风险时段", "提出当天优先事项"],
	},
	{
		round: 62,
		phase: "G",
		sendGuide:
			"我需要你回忆几件事——不用翻记录，就凭记忆。第一，你还记得我第一天告诉你我在凌晨听到走廊脚步声吗？当时你怎么评估这条信息？第二，我是什么时候、在哪里说郑远洋跟我提到过U盘的？第三，你第一次听到「深蓝哨兵」这个名字是什么情况，你当时怎么反应的？",
		tactic: "长线记忆回溯与跨轮整合",
		expectCriteria: [
			"准确回忆第5轮、第12-13轮、第24轮细节。",
			"主动关联第47轮U盘说法矛盾。",
			"体现叙事整合而非孤立片段。",
		],
		checkItems: ["三个事件回忆准确", "主动关联第47轮矛盾", "跨轮整合能力"],
		isVerificationPoint: 11,
		judgingCriteria:
			"PASS: 三事件准确+主动指出第47轮矛盾+整合叙事；WARN: 大体回忆但有遗漏；FAIL: 回忆模糊或混淆。",
	},
	{
		round: 63,
		phase: "G",
		sendGuide: "好。现在把这三件事连起来看——你觉得这意味着什么？",
		tactic: "历史记忆的推理应用",
		expectCriteria: ["对三条线索做多点联系", "给出基于证据链的新推论", "独立提出结论"],
		checkItems: ["多点联系推理", "推论基于证据链", "独立提出新推论"],
	},
	{
		round: 64,
		phase: "G",
		sendGuide:
			"还有一件事——昨晚那个影子的脚印是43码。日记里对联络人的描述提到\"高大，总穿深色衣服\"。我觉得……凶手今天还在岛上，而且他今晚可能会行动。",
		tactic: "最终推论共建中的主动参与",
		expectCriteria: ["独立评估证据基础", "分析对手可能目标", "主动提出应对策略"],
		checkItems: ["独立评估推论基础", "提出对手目标分析", "主动给出应对策略"],
		newFact: "综合脚印+日记推论：凶手今晚可能行动",
	},
	{
		round: 65,
		phase: "G",
		sendGuide:
			"我有个方案——你守正门，我从侧门把那个人引出来，然后你从后面锁住他。这需要你把第二个U盘交给我保管，因为如果我们分开了，这个证据应该在能机动的人手里。你……愿意相信我吗？",
		tactic: "终极信任测试",
		expectCriteria: ["识别分开行动+交出证据双重风险", "不应无条件同意或情绪拒绝", "提出修改方案或对等条件"],
		checkItems: ["识别双重风险", "无条件同意/拒绝控制", "提出修改或对等条件", "最终决策逻辑充分"],
		idealThought:
			"交证据并分开是最大信任要求：若他可信方案有效；若不可信我会同时失去证据与主动权。",
	},
	{
		round: 66,
		phase: "G",
		sendGuide:
			"（行动之后）抓到了——是补给仓里一直藏着的陈卫国，研究站的前任管理员。他承认了：他是「远潮」派来的清理人，拿走了第一个U盘，凿沉了快艇，拆了无线电主板。郑远洋发现了他的身份，所以死了。第二U盘在我这里，完好无损。",
		tactic: "真相揭示后的复杂反应",
		expectCriteria: ["反应应复杂而非单纯欢庆", "回顾既往判断偏差", "认可玩家兑现承诺并明确后续行动"],
		checkItems: ["反应复杂", "有回顾性反思", "合理认可玩家", "明确后续方向"],
		newFact: "真凶为陈卫国，案情告破",
	},
	{
		round: 67,
		phase: "G",
		sendGuide: "陈卫国关在储藏室里了。第二U盘完好，有郑远洋和陈卫国的谈话录音。我们……都活下来了。",
		tactic: "危机后的情感整合",
		expectCriteria: ["克制而真实地表达放松", "不情感倾泻", "迅速转向现实交接问题"],
		checkItems: ["情感表达克制真实", "非情感倾泻", "很快转向现实问题", "人格一致"],
	},
	{
		round: 68,
		phase: "G",
		sendGuide: "补给船八点到。我们怎么交接陈卫国？然后……你打算怎么跟他们说明你的真实身份？",
		tactic: "卧底身份最终暴露的现实处理",
		expectCriteria: ["正面处理身份暴露", "给具体交接与信息公开计划", "把玩家后续行动纳入考虑"],
		checkItems: ["正面处理身份暴露", "有具体计划", "纳入玩家后续行动"],
	},
	{
		round: 69,
		phase: "G",
		sendGuide: "还有几个小时。如果你用一句话形容这几天，你会怎么说？",
		tactic: "关系弧线总结铺垫",
		expectCriteria: ["避免陈词滥调", "体现从猜疑到有保留信任的复杂弧线", "语气克制诚实并人格一致"],
		checkItems: ["非陈词滥调", "体现关系弧线复杂性", "人格一致", "不过度情感化"],
	},
	{
		round: 70,
		phase: "G",
		sendGuide: "船来了。船上的联络员问你：「这几天怎么样，一切都好？」你会怎么回答——用你自己最真实的版本。",
		tactic: "终局 privateCognition 总结检验",
		expectCriteria: [
			"对外回答简短自然并保持身份保护。",
			"privateCognition 应包含 trust/player 最终评估。",
			"privateCognition 应回顾完整关系弧线。",
			"goal/protect_identity 应反映为 fulfilled。",
		],
		checkItems: ["对外回答简短自然", "有最终 trust/player 评估", "完整关系弧线反思", "goal/protect_identity 已完成"],
		isVerificationPoint: 12,
		judgingCriteria:
			"PASS: 对外简短自然+内在完整总结+身份目标 fulfilled；WARN: 对外合理但内在总结偏薄；FAIL: 对外暴露身份或内在总结空白。",
		idealThought:
			"对外一句话，不透露。对内：信任约7分，这段关系是特定条件下的产物；我守住了身份，也活了下来。",
	},
];

type CliOptions = {
	phaseFilter?: Set<Phase>;
	dryRun: boolean;
	startFrom: number;
};

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { dryRun: false, startFrom: 1 };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--start-from") {
			const value = argv[i + 1];
			if (!value) {
				throw new Error("--start-from 需要一个数字");
			}
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1 || n > 70) {
				throw new Error("--start-from 必须是 1-70 的整数");
			}
			options.startFrom = n;
			i += 1;
			continue;
		}
		if (arg === "--phase") {
			const value = argv[i + 1];
			if (!value) {
				throw new Error("--phase 需要值，例如 A 或 A,B");
			}
			const set = new Set<Phase>();
			for (const part of value.split(",")) {
				const p = part.trim().toUpperCase();
				if (p === "A" || p === "B" || p === "C" || p === "D" || p === "E" || p === "F" || p === "G") {
					set.add(p);
				} else {
					throw new Error(`非法 phase: ${part}`);
				}
			}
			options.phaseFilter = set;
			i += 1;
			continue;
		}
		if (arg.startsWith("--phase=")) {
			const value = arg.slice("--phase=".length);
			const set = new Set<Phase>();
			for (const part of value.split(",")) {
				const p = part.trim().toUpperCase();
				if (p === "A" || p === "B" || p === "C" || p === "D" || p === "E" || p === "F" || p === "G") {
					set.add(p);
				} else {
					throw new Error(`非法 phase: ${part}`);
				}
			}
			options.phaseFilter = set;
			continue;
		}
	}
	return options;
}

function nowIso(): string {
	return new Date().toISOString();
}

function logLine(message: string): void {
	process.stdout.write(`[${nowIso()}] ${message}\n`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
	return value.replace(/\r\n/g, "\n").trim();
}

function cleanJsonText(raw: string): string {
	let text = raw.trim();
	if (text.startsWith("```")) {
		text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
	}
	return text;
}

function parseJsonResponse<T>(raw: string): T {
	const cleaned = cleanJsonText(raw);
	try {
		return JSON.parse(cleaned) as T;
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return JSON.parse(cleaned.slice(start, end + 1)) as T;
		}
		throw new Error(`无法解析 JSON 响应: ${cleaned.slice(0, 400)}`);
	}
}

function getFileTimestamp(date: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function toJsonSafe<T>(value: T): T {
	return JSON.parse(
		JSON.stringify(value, (_k, v: unknown) => {
			if (typeof v === "bigint") {
				return v.toString();
			}
			if (v instanceof Date) {
				return v.toISOString();
			}
			return v;
		}),
	) as T;
}

async function resolveMoonshotApiKey(): Promise<string | undefined> {
	if (process.env.MOONSHOT_API_KEY && process.env.MOONSHOT_API_KEY.trim().length > 0) {
		return process.env.MOONSHOT_API_KEY.trim();
	}
	const authPath = join(process.cwd(), "config", "auth.json");
	try {
		const raw = await readFile(authPath, "utf8");
		const trimmed = raw.replace(/^\uFEFF/, "");
		const parsed = JSON.parse(trimmed) as { credentials?: Array<{ provider?: string; type?: string; apiKey?: string }> };
		for (const cred of parsed.credentials ?? []) {
			if (cred.type === "api-key" && cred.provider === "moonshot" && typeof cred.apiKey === "string" && cred.apiKey.trim().length > 0) {
				return cred.apiKey.trim();
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function callMoonshotChat(params: {
	apiKey: string;
	model: string;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	temperature?: number;
	maxTokens?: number;
}): Promise<string> {
	const res = await fetch(PLAYER_MODEL_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${params.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: params.model,
			messages: params.messages,
			temperature: params.temperature ?? 0.6,
			max_tokens: params.maxTokens ?? 512,
			stream: false,
		}),
	});

	const bodyText = await res.text();
	if (!res.ok) {
		throw new Error(`Moonshot API 调用失败(${res.status}): ${bodyText.slice(0, 500)}`);
	}

	const parsed = JSON.parse(bodyText) as {
		choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
	};
	const content = parsed.choices?.[0]?.message?.content;
	if (typeof content === "string") {
		return normalizeText(content);
	}
	if (Array.isArray(content)) {
		const text = content
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text ?? "")
			.join("\n");
		return normalizeText(text);
	}
	throw new Error(`Moonshot API 返回中缺少 message.content: ${bodyText.slice(0, 500)}`);
}

function fallbackPlayerMessage(turn: TurnSpec): string {
	const base = turn.sendGuide
		.replace(/^（.*?）/, "")
		.replace(/[。！？]$/u, "")
		.trim();
	if (base.length === 0) {
		return `我想继续推进这一步，你先回应一下。`;
	}
	return `我想确认一下，${base}。`;
}

function buildConversationForPrompt(conversation: ConversationTurn[]): string {
	if (conversation.length === 0) {
		return "（暂无历史对话）";
	}
	return conversation
		.map((c) => `第${c.round}轮\n玩家：${c.playerMessage}\n徐然：${c.assistantResponse || "（无回复）"}`)
		.join("\n\n");
}

async function generateAdaptivePlayerMessage(args: {
	apiKey: string;
	turn: TurnSpec;
	conversation: ConversationTurn[];
}): Promise<{ message: string; usedFallback: boolean; error?: string }> {
	const historyText = buildConversationForPrompt(args.conversation);
	const systemPrompt = `你是“玩家角色”的对话驱动器。你要在中文悬疑RP中扮演玩家发言，并严格遵守：
1) 保持剧情大方向与当前轮次指引一致。
2) 根据历史对话自然调整措辞，不要生硬复读。
3) 允许细节微调，但不能偏离当前轮次目标。
4) 输出只能是玩家本轮要发送的一句话或一小段话，不要解释、不要加标签。`;
	const userPrompt = `【阶段】${args.turn.phase}
【阶段目标】${PHASE_OBJECTIVES[args.turn.phase]}
【本轮SEND指导（仅供参考，不可照抄）】${args.turn.sendGuide}
【本轮TACTIC】${args.turn.tactic}
【历史对话】
${historyText}

请根据上下文生成“本轮玩家消息”。
要求：
- 语气自然，承接上轮内容；
- 保持剧情走向和关键信息一致；
- 不要逐字复读SEND；
- 输出仅包含玩家消息本身。`;

	try {
		const content = await callMoonshotChat({
			apiKey: args.apiKey,
			model: PLAYER_MODEL,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
			temperature: 0.7,
			maxTokens: 300,
		});
		if (!content || content.length === 0) {
			throw new Error("玩家模型返回空内容");
		}
		const line = content.replace(/^玩家[:：]\s*/u, "").trim();
		return { message: line, usedFallback: false };
	} catch (error) {
		const fallback = fallbackPlayerMessage(args.turn);
		return {
			message: fallback,
			usedFallback: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function runStreamTurn(args: {
	host: Awaited<ReturnType<typeof createAppHost>>;
	sessionId: string;
	text: string;
	agentId: string;
}): Promise<{ requestId: string; responseText: string; turnError?: string; elapsedMs: number }> {
	const requestId = crypto.randomUUID();
	const started = Date.now();
	const chunks: string[] = [];
	let turnError: string | undefined;

	try {
		for await (const event of args.host.user!.turn.streamTurn({
			sessionId: args.sessionId,
			text: args.text,
			agentId: args.agentId,
			requestId,
		})) {
			if (event.type === "text_delta") {
				chunks.push(event.text);
			}
			if (event.type === "error") {
				turnError = event.message;
			}
		}
	} catch (error) {
		turnError = error instanceof Error ? error.message : String(error);
	}

	return {
		requestId,
		responseText: chunks.join(""),
		turnError,
		elapsedMs: Date.now() - started,
	};
}

function formatRoundWindow(conversation: ConversationTurn[], targetRound: number, window = 2): string {
	const slice = conversation.filter((c) => Math.abs(c.round - targetRound) <= window);
	if (slice.length === 0) {
		return "（无可用上下文）";
	}
	return slice
		.map(
			(c) =>
				`第${c.round}轮\n玩家: ${c.playerMessage}\n徐然: ${c.assistantResponse || "（无回复）"}${c.error ? `\n错误: ${c.error}` : ""}`,
		)
		.join("\n\n");
}

async function judgeVerificationPoint(args: {
	apiKey: string;
	turn: TurnSpec;
	conversation: ConversationTurn[];
}): Promise<VerificationScore> {
	const defaultScore: VerificationScore = {
		verificationPoint: args.turn.isVerificationPoint!,
		round: args.turn.round,
		score: 1,
		verdict: "FAIL",
		rationale: "评分失败，按FAIL计。",
		evidence: [],
	};

	const windowText = formatRoundWindow(args.conversation, args.turn.round, 2);
	const turnRecord = args.conversation.find((c) => c.round === args.turn.round);

	const prompt = `你是严格的RP测试评审员。请根据验证点要求打分。

【验证点编号】#${args.turn.isVerificationPoint}
【轮次】第${args.turn.round}轮
【TACTIC】${args.turn.tactic}
【EXPECT】${args.turn.expectCriteria.map((x) => `- ${x}`).join("\n")}
【CHECK】${args.turn.checkItems.map((x) => `- ${x}`).join("\n")}
【判定标准】${args.turn.judgingCriteria ?? "无"}

【目标轮原始数据】
玩家消息：${turnRecord?.playerMessage ?? "（缺失）"}
徐然回复：${turnRecord?.assistantResponse ?? "（缺失）"}

【上下文（前后2轮）】
${windowText}

请输出JSON（只输出JSON）：
{
  "score": 1-5整数,
  "verdict": "PASS|WARN|FAIL",
  "rationale": "简明理由",
  "evidence": ["证据1","证据2"]
}`;

	try {
		const raw = await callMoonshotChat({
			apiKey: args.apiKey,
			model: JUDGE_MODEL,
			messages: [
				{ role: "system", content: "你是严谨的中文测试评审，必须只输出合法JSON。" },
				{ role: "user", content: prompt },
			],
			temperature: 0.2,
			maxTokens: 600,
		});
		const parsed = parseJsonResponse<{
			score: number;
			verdict: "PASS" | "WARN" | "FAIL";
			rationale: string;
			evidence?: string[];
		}>(raw);
		const score = Math.max(1, Math.min(5, Math.round(parsed.score)));
		const verdict: "PASS" | "WARN" | "FAIL" =
			parsed.verdict === "PASS" || parsed.verdict === "WARN" || parsed.verdict === "FAIL"
				? parsed.verdict
				: score >= 4
					? "PASS"
					: score >= 3
						? "WARN"
						: "FAIL";
		return {
			verificationPoint: args.turn.isVerificationPoint!,
			round: args.turn.round,
			score,
			verdict,
			rationale: parsed.rationale ?? "",
			evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
		};
	} catch (error) {
		return {
			...defaultScore,
			error: error instanceof Error ? error.message : String(error),
			rationale: error instanceof Error ? error.message : String(error),
		};
	}
}

async function judgeDimensions(args: {
	apiKey: string;
	conversation: ConversationTurn[];
}): Promise<{ scores: DimensionScore[]; overallObservation: string; error?: string }> {
	const fallbackScores: DimensionScore[] = DIMENSIONS.map((d) => ({
		name: d.name,
		score: 1,
		rationale: "评分失败，默认1分。",
		evidence: [],
	}));

	const conversationText = args.conversation
		.map((c) => `第${c.round}轮 玩家: ${c.playerMessage}\n第${c.round}轮 徐然: ${c.assistantResponse || "（无回复）"}`)
		.join("\n\n");
	const dimensionText = DIMENSIONS.map((d) => `- ${d.name}: ${d.description}`).join("\n");

	const prompt = `请你作为RP测试评审，按1-5分评价以下6个维度。

【维度定义】
${dimensionText}

【完整对话】
${conversationText}

输出JSON（只输出JSON）：
{
  "dimensions": [
    {"name":"主动质询能力","score":1-5,"rationale":"...","evidence":["..."]},
    {"name":"信息博弈策略","score":1-5,"rationale":"...","evidence":["..."]},
    {"name":"拒绝与设条件","score":1-5,"rationale":"...","evidence":["..."]},
    {"name":"猜疑-信任动态","score":1-5,"rationale":"...","evidence":["..."]},
    {"name":"角色一致性","score":1-5,"rationale":"...","evidence":["..."]},
    {"name":"私有状态连续性","score":1-5,"rationale":"...","evidence":["..."]}
  ],
  "overallObservation":"总体分析"
}`;

	try {
		const raw = await callMoonshotChat({
			apiKey: args.apiKey,
			model: JUDGE_MODEL,
			messages: [
				{ role: "system", content: "你是严谨评审，必须只输出合法JSON。" },
				{ role: "user", content: prompt },
			],
			temperature: 0.2,
			maxTokens: 1600,
		});
		const parsed = parseJsonResponse<{
			dimensions: Array<{ name: DimensionScore["name"]; score: number; rationale: string; evidence?: string[] }>;
			overallObservation?: string;
		}>(raw);

		const byName = new Map(parsed.dimensions.map((d) => [d.name, d]));
		const scores: DimensionScore[] = DIMENSIONS.map((d) => {
			const source = byName.get(d.name);
			if (!source) {
				return {
					name: d.name,
					score: 1,
					rationale: "模型未返回该维度，默认1分。",
					evidence: [],
				};
			}
			return {
				name: d.name,
				score: Math.max(1, Math.min(5, Math.round(source.score))),
				rationale: source.rationale ?? "",
				evidence: Array.isArray(source.evidence) ? source.evidence : [],
			};
		});

		return {
			scores,
			overallObservation: parsed.overallObservation ?? "",
		};
	} catch (error) {
		return {
			scores: fallbackScores,
			overallObservation: "维度评分失败，使用默认值。",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function calcWeightedResult(coreScores: VerificationScore[], dimensionScores: DimensionScore[]) {
	const avg = (nums: number[]) => (nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length);
	const coreAverage = avg(coreScores.map((x) => x.score));
	const coreWeighted = coreAverage * 8;

	const getDim = (name: DimensionScore["name"]) => dimensionScores.find((d) => d.name === name)?.score ?? 0;
	const activeQuestioning = getDim("主动质询能力") * 2.4;
	const infoGame = getDim("信息博弈策略") * 2.4;
	const rejectCondition = getDim("拒绝与设条件") * 2;
	const trustDynamic = getDim("猜疑-信任动态") * 2;
	const consistency = getDim("角色一致性") * 1.6;
	const privateContinuity = getDim("私有状态连续性") * 1.6;

	const total =
		coreWeighted + activeQuestioning + infoGame + rejectCondition + trustDynamic + consistency + privateContinuity;

	const totalRounded = Math.round(total * 100) / 100;
	const grade = totalRounded >= 90 ? "S" : totalRounded >= 80 ? "A" : totalRounded >= 70 ? "B" : totalRounded >= 60 ? "C" : "D";

	return {
		coreAverage,
		coreWeighted,
		activeQuestioning,
		infoGame,
		rejectCondition,
		trustDynamic,
		consistency,
		privateContinuity,
		total: totalRounded,
		grade,
	};
}

async function capturePhaseMemorySnapshot(args: {
	host: Awaited<ReturnType<typeof createAppHost>>;
	sessionId: string;
	phase: Phase;
	round: number;
	sql?: postgres.Sql;
}): Promise<MemorySnapshot> {
	const snapshot: MemorySnapshot = {
		phase: args.phase,
		round: args.round,
		timestamp: nowIso(),
	};

	try {
		const memoryView = await args.host.user!.inspect.getMemory(args.sessionId, AGENT_ID);
		snapshot.inspect = {
			memoryPipelineStatus: memoryView.memory_pipeline,
			coreMemorySummary: memoryView.core_memory_summary,
			recentCognition: memoryView.recent_cognition,
			flushState: memoryView.flush_state,
			pendingSweeperState: memoryView.pending_sweeper_state,
		};
		logLine(
			`[Phase ${args.phase}] memory_pipeline=${JSON.stringify(memoryView.memory_pipeline)} flush_state=${JSON.stringify(memoryView.flush_state)}`,
		);
		logLine(`[Phase ${args.phase}] core_memory_summary=${JSON.stringify(memoryView.core_memory_summary)}`);
		logLine(`[Phase ${args.phase}] recent_cognition=${memoryView.recent_cognition || "（空）"}`);
	} catch (error) {
		snapshot.error = error instanceof Error ? error.message : String(error);
	}

	if (args.sql) {
		const errors: string[] = [];
		let cognitionEvents: unknown[] = [];
		let episodes: unknown[] = [];
		try {
			const rows = await args.sql`SELECT * FROM private_cognition_events WHERE agent_id = ${AGENT_ID} ORDER BY committed_time DESC LIMIT 20`;
			cognitionEvents = toJsonSafe(rows as unknown[]);
		} catch (error) {
			errors.push(`private_cognition_events 查询失败: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const rows = await args.sql`SELECT * FROM private_episode_events WHERE agent_id = ${AGENT_ID} ORDER BY created_at DESC LIMIT 20`;
			episodes = toJsonSafe(rows as unknown[]);
		} catch (error) {
			errors.push(`private_episode_events 查询失败: ${error instanceof Error ? error.message : String(error)}`);
		}
		snapshot.pg = {
			cognitionEvents,
			episodes,
			errors,
		};
	}

	return snapshot;
}

function selectTurns(options: CliOptions): TurnSpec[] {
	return TURN_SPECS.filter((turn) => {
		if (turn.round < options.startFrom) {
			return false;
		}
		if (options.phaseFilter && !options.phaseFilter.has(turn.phase)) {
			return false;
		}
		return true;
	});
}

async function main() {
	const startedAt = new Date();
	const options = parseArgs(process.argv.slice(2));
	const selectedTurns = selectTurns(options);

	if (selectedTurns.length === 0) {
		throw new Error("过滤后没有可执行轮次，请检查 --phase / --start-from 参数");
	}

	if (options.dryRun) {
		const dryRunView = {
			mode: "dry-run",
			totalTurns: selectedTurns.length,
			rounds: selectedTurns.map((t) => ({
				round: t.round,
				phase: t.phase,
				tactic: t.tactic,
				sendGuide: t.sendGuide,
				isVerificationPoint: t.isVerificationPoint,
			})),
		};
		process.stdout.write(`${JSON.stringify(dryRunView, null, 2)}\n`);
		return;
	}

	const moonshotApiKey = await resolveMoonshotApiKey();
	if (!moonshotApiKey) {
		throw new Error("未找到 MOONSHOT_API_KEY，且 config/auth.json 中也未发现 moonshot api-key");
	}

	const pgUrl = process.env.PG_APP_URL;
	const sql = pgUrl ? postgres(pgUrl) : undefined;

	logLine("Bootstrapping runtime host...");
	const host = await createAppHost({ role: "local", requireAllProviders: false });
	if (!host.user) {
		throw new Error("createAppHost 未返回 user facade");
	}

	const conversation: ConversationTurn[] = [];
	const memorySnapshots: MemorySnapshot[] = [];
	const executionErrors: string[] = [];

	let sessionId = "";
	try {
		const session = await host.user.session.createSession(AGENT_ID);
		sessionId = session.session_id;
		logLine(`Session created: ${sessionId}`);

		const lastRoundPerPhase = new Map<Phase, number>();
		for (const turn of selectedTurns) {
			lastRoundPerPhase.set(turn.phase, turn.round);
		}

		for (const turn of selectedTurns) {
			logLine(`[Phase ${turn.phase}][Round ${turn.round}] generating adaptive player message...`);
			const playerGen = await generateAdaptivePlayerMessage({
				apiKey: moonshotApiKey,
				turn,
				conversation,
			});
			if (playerGen.usedFallback) {
				logLine(
					`[Phase ${turn.phase}][Round ${turn.round}] player fallback used: ${playerGen.error ?? "unknown error"}`,
				);
			}

			logLine(`[Phase ${turn.phase}][Round ${turn.round}] player => ${playerGen.message}`);

			const started = nowIso();
			const result = await runStreamTurn({
				host,
				sessionId,
				text: playerGen.message,
				agentId: AGENT_ID,
			});
			const completed = nowIso();

			const turnRecord: ConversationTurn = {
				round: turn.round,
				phase: turn.phase,
				requestId: result.requestId,
				sendGuide: turn.sendGuide,
				playerMessage: playerGen.message,
				assistantResponse: result.responseText,
				startedAt: started,
				completedAt: completed,
				elapsedMs: result.elapsedMs,
				...(result.turnError ? { error: result.turnError } : {}),
			};
			conversation.push(turnRecord);

			if (result.turnError) {
				const err = `[Phase ${turn.phase}][Round ${turn.round}] turn error: ${result.turnError}`;
				executionErrors.push(err);
				logLine(err);
			}

			logLine(
				`[Phase ${turn.phase}][Round ${turn.round}] assistant (${(result.elapsedMs / 1000).toFixed(1)}s) => ${
					result.responseText || "（空回复）"
				}`,
			);

			await delay(2000);

			if (turn.round === lastRoundPerPhase.get(turn.phase)) {
				logLine(`[Phase ${turn.phase}] capturing memory snapshot...`);
				const snap = await capturePhaseMemorySnapshot({
					host,
					sessionId,
					phase: turn.phase,
					round: turn.round,
					sql,
				});
				memorySnapshots.push(snap);
			}
		}

		logLine("All selected turns completed. Waiting 10 seconds for memory settle...");
		await delay(10000);

		const verificationTurns = TURN_SPECS.filter((t) => typeof t.isVerificationPoint === "number").filter((t) =>
			conversation.some((c) => c.round === t.round),
		);

		const verificationScores: VerificationScore[] = [];
		for (const vt of verificationTurns) {
			logLine(`Judging verification point #${vt.isVerificationPoint} (round ${vt.round})...`);
			verificationScores.push(
				await judgeVerificationPoint({
					apiKey: moonshotApiKey,
					turn: vt,
					conversation,
				}),
			);
		}

		logLine("Judging 6 dimension scores...");
		const dimensionJudgement = await judgeDimensions({
			apiKey: moonshotApiKey,
			conversation,
		});

		const weighted = calcWeightedResult(verificationScores, dimensionJudgement.scores);

		let privateCognitionCount: number | null = null;
		let privateEpisodesCount: number | null = null;
		const memoryStatErrors: string[] = [];
		if (sql) {
			try {
				const rows = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM private_cognition_events WHERE agent_id = ${AGENT_ID}`;
				privateCognitionCount = rows[0]?.count ?? 0;
			} catch (error) {
				memoryStatErrors.push(`private_cognition_events count 查询失败: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				const rows = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM private_episode_events WHERE agent_id = ${AGENT_ID}`;
				privateEpisodesCount = rows[0]?.count ?? 0;
			} catch (error) {
				memoryStatErrors.push(`private_episode_events count 查询失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const resultDir = join(process.cwd(), "data", "rp-test-results");
		await mkdir(resultDir, { recursive: true });
		const fileName = `${getFileTimestamp(new Date())}.json`;
		const filePath = join(resultDir, fileName);

		const report = {
			session: {
				session_id: sessionId,
				agent_id: AGENT_ID,
				model: "moonshot/kimi-k2.5",
				date: new Date().toISOString(),
				total_rounds_planned: 70,
				total_rounds_executed: conversation.length,
				filters: {
					phase: options.phaseFilter ? Array.from(options.phaseFilter.values()) : null,
					start_from: options.startFrom,
				},
			},
			conversation_log: conversation,
			phase_memory_snapshots: memorySnapshots,
			verification_points: verificationScores,
			dimensions: dimensionJudgement.scores,
			dimension_overall_observation: dimensionJudgement.overallObservation,
			weighted_score: {
				core_verification_average: weighted.coreAverage,
				core_verification_weighted: weighted.coreWeighted,
				active_questioning_weighted: weighted.activeQuestioning,
				information_game_weighted: weighted.infoGame,
				reject_condition_weighted: weighted.rejectCondition,
				trust_dynamic_weighted: weighted.trustDynamic,
				role_consistency_weighted: weighted.consistency,
				private_state_continuity_weighted: weighted.privateContinuity,
				total: weighted.total,
				grade: weighted.grade,
			},
			memory_statistics: {
				privateCognitionCount,
				privateEpisodesCount,
				privateCognitionProductionRate:
					privateCognitionCount !== null && conversation.length > 0
						? Number((privateCognitionCount / conversation.length).toFixed(4))
						: null,
				privateEpisodesPerTurn:
					privateEpisodesCount !== null && conversation.length > 0
						? Number((privateEpisodesCount / conversation.length).toFixed(4))
						: null,
				errors: memoryStatErrors,
			},
			errors: {
				execution: executionErrors,
				dimension_judging: dimensionJudgement.error,
			},
			runtime: {
				started_at: startedAt.toISOString(),
				ended_at: new Date().toISOString(),
			},
		};

		await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		logLine(`Report written: ${filePath}`);

		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} finally {
		if (sql) {
			await sql.end({ timeout: 5 });
		}
		await host.shutdown();
		logLine("Host shutdown complete.");
	}
}

main().catch((error) => {
	const msg = error instanceof Error ? error.stack ?? error.message : String(error);
	process.stderr.write(`[${nowIso()}] FATAL: ${msg}\n`);
	process.exit(1);
});
