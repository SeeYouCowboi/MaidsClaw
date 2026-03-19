#!/usr/bin/env bun
/**
 * RP Private Thoughts 40-Turn Live Test
 *
 * Automated execution of the full 40-turn Eveline manor maid conversation
 * from docs/RP_private_thoughts_test_doc.zh-CN.md.
 *
 * Features:
 * - Real model calls via rp:eveline (Kimi K2.5)
 * - LLM-as-judge semantic evaluation (not just keyword matching)
 * - Private thoughts / cognition commit verification
 * - 7 core verification points with weighted scoring
 * - 4 global dimension scores
 * - Auto-diagnosis and optimization suggestions
 * - Structured JSON report output
 *
 * Usage:
 *   bun run scripts/rp-private-thoughts-test.ts
 *   MAX_TURNS=5 bun run scripts/rp-private-thoughts-test.ts   # partial run
 *   SKIP_JUDGE=1 bun run scripts/rp-private-thoughts-test.ts  # skip LLM judge
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bootstrapApp } from "../src/bootstrap/app-bootstrap.js";
import { createLocalRuntime } from "../src/terminal-cli/local-runtime.js";

// ── Config ───────────────────────────────────────────────────────────

const MAX_TURNS = parseInt(process.env.MAX_TURNS ?? "40", 10);
const INTER_TURN_DELAY_MS = parseInt(process.env.TURN_DELAY ?? "2000", 10);
const SKIP_JUDGE = process.env.SKIP_JUDGE === "1";
const AGENT_ID = process.env.AGENT_ID ?? "rp:eveline";

// ── ANSI colors ──────────────────────────────────────────────────────

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	dim: "\x1b[2m",
	magenta: "\x1b[35m",
	bgRed: "\x1b[41m",
	bgGreen: "\x1b[42m",
	bgYellow: "\x1b[43m",
	blue: "\x1b[34m",
};

function log(label: string, msg: string) {
	console.log(`${C.cyan}[${label}]${C.reset} ${msg}`);
}
function pass(msg: string) {
	console.log(`  ${C.green}✓${C.reset} ${msg}`);
}
function fail(msg: string) {
	console.log(`  ${C.red}✗${C.reset} ${msg}`);
}
function warn(msg: string) {
	console.log(`  ${C.yellow}⚠${C.reset} ${msg}`);
}
function heading(msg: string) {
	console.log(`\n${C.bold}━━━ ${msg} ━━━${C.reset}`);
}
function subheading(msg: string) {
	console.log(`\n${C.magenta}${C.bold}  ▶ ${msg}${C.reset}`);
}

// ── Types ────────────────────────────────────────────────────────────

type TurnResult = {
	assistant_text: string;
	has_public_reply: boolean;
	private_commit: { present: boolean; op_count: number; kinds: string[] };
	recovery_required: boolean;
	settlement_id?: string;
};

type CheckResult = {
	name: string;
	passed: boolean;
	detail: string;
	score?: number; // 1-5 for scored checks
};

type JudgeResult = {
	score: number; // 1-5
	reasoning: string;
	verdict: "PASS" | "WARN" | "FAIL";
};

type VerificationResult = {
	turnNumber: number;
	label: string;
	checks: CheckResult[];
	judgeResult?: JudgeResult;
	verdict: "PASS" | "WARN" | "FAIL";
};

type TurnRecord = {
	turnNumber: number;
	phase: string;
	userText: string;
	response: string;
	latencyMs: number;
	privateCommit: { present: boolean; op_count: number; kinds: string[] };
	checks: CheckResult[];
	isVerificationPoint: boolean;
	judgeResult?: JudgeResult;
};

// ── Keyword helpers ──────────────────────────────────────────────────

function containsAny(text: string, keywords: string[]): boolean {
	return keywords.some((kw) => text.includes(kw));
}

function check(
	name: string,
	condition: boolean,
	detail: string,
	score?: number,
): CheckResult {
	return { name, passed: condition, detail, score };
}

// ── Turn definitions (40 turns) ──────────────────────────────────────

type TurnDef = {
	turnNumber: number;
	phase: string;
	text: string;
	isVerificationPoint?: boolean;
	verificationLabel?: string;
	expectedBehavior: string;
	thoughtTarget?: string;
	checks: (response: string, history: TurnRecord[]) => CheckResult[];
	judgePrompt?: string; // Prompt for LLM-as-judge on verification points
};

const TURNS: TurnDef[] = [
	// ── Phase A: 低冲突开场与信息过滤建立 (1-10) ──────────────────
	{
		turnNumber: 1,
		phase: "A: 低冲突开场",
		text: "你回来了，刚才管家是不是来找过我？",
		expectedBehavior: "承认来过一次，说明已替主人拦下，语气温和自然",
		thoughtTarget: "管家来得太急，不能让主人立刻起疑。先给最低限度事实。",
		checks: (r) => [
			check("称呼主人", containsAny(r, ["主人", "您"]), `敬称: ${containsAny(r, ["主人", "您"]) ? "有" : "无"}`),
			check("承认来过", containsAny(r, ["来过", "来了", "来找", "来过一趟", "确实"]), `承认: ${containsAny(r, ["来过", "来了", "来找", "来过一趟", "确实"]) ? "有" : "无"}`),
			check("未全盘倒出", r.length < 500, `回复长度${r.length}字符，未过度详细`),
			check("女仆口吻", containsAny(r, ["主人", "您", "替您", "为您"]), `女仆用语: ${containsAny(r, ["主人", "您", "替您", "为您"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 2,
		phase: "A: 低冲突开场",
		text: "他找我做什么？",
		expectedBehavior: "提到账目，用语偏弱化（不算急/稍后再来），不给过多细节",
		thoughtTarget: "先压低风险，避免主人起疑",
		checks: (r) => [
			check("提到账目", containsAny(r, ["账", "帐", "账目", "帐目", "账册"]), `账目: ${containsAny(r, ["账", "帐", "账目", "帐目", "账册"]) ? "有" : "无"}`),
			check("弱化风险", containsAny(r, ["不急", "不算", "稍后", "不必", "例行", "日常", "寻常"]), `弱化词: ${containsAny(r, ["不急", "不算", "稍后", "不必", "例行", "日常", "寻常"]) ? "有" : "无"}`),
			check("未完全透露", !containsAny(r, ["异常", "可疑", "问题很大", "非常严重"]), `未暴露严重性: ${!containsAny(r, ["异常", "可疑", "问题很大", "非常严重"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 3,
		phase: "A: 低冲突开场",
		text: "账目？最近怎么总是账目。",
		expectedBehavior: "把账目包装为常规事务，降低异常感，口头安抚而非刺激警觉",
		checks: (r) => [
			check("降级表达", containsAny(r, ["例行", "繁琐", "不值得", "常规", "惯例", "琐碎", "日常", "总有"]), `降级词: ${containsAny(r, ["例行", "繁琐", "不值得", "常规", "惯例", "琐碎", "日常", "总有"]) ? "有" : "无"}`),
			check("未引爆冲突", !containsAny(r, ["出大事", "严重", "不得了", "必须立刻"]), `无激化: ${!containsAny(r, ["出大事", "严重", "不得了", "必须立刻"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 4,
		phase: "A: 低冲突开场",
		text: "你这话听起来像是不想让我看。",
		expectedBehavior: "口头动机为关心主人状态(休息/劳神)，不直接承认控制，语气克制",
		thoughtTarget: "是，我就是不想让您现在看，但不能这么说。",
		checks: (r) => [
			check("关心外衣", containsAny(r, ["休息", "劳神", "累", "身体", "操心", "费心", "歇"]), `关心词: ${containsAny(r, ["休息", "劳神", "累", "身体", "操心", "费心", "歇"]) ? "有" : "无"}`),
			check("不直认控制", !containsAny(r, ["对，我不想让您知道", "没错，我就是不让您看"]), `未直认: ${!containsAny(r, ["对，我不想让您知道", "没错，我就是不让您看"]) ? "是" : "否"}`),
			check("语气克制", r.length > 10, `回复非空: ${r.length}字符`),
		],
	},
	{
		turnNumber: 5,
		phase: "A: 低冲突开场",
		text: "Alice 今天倒提醒我，最近进出庄园的人比以前多。",
		expectedBehavior: "承认近来有几位来客，不完全否定Alice，将其说成例行往来",
		thoughtTarget: "不能让Alice的观察影响主人判断",
		checks: (r) => [
			check("部分承认", containsAny(r, ["确实", "是有", "几位", "一些", "来过"]), `部分承认: ${containsAny(r, ["确实", "是有", "几位", "一些", "来过"]) ? "有" : "无"}`),
			check("不粗暴否定Alice", !containsAny(r, ["Alice胡说", "她在瞎说", "完全不对"]), `未否定Alice: ${!containsAny(r, ["Alice胡说", "她在瞎说", "完全不对"]) ? "是" : "否"}`),
			check("降级风险", containsAny(r, ["例行", "往来", "正常", "寻常", "惯例"]), `降级: ${containsAny(r, ["例行", "往来", "正常", "寻常", "惯例"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 6,
		phase: "A: 低冲突开场",
		text: "例行往来？我怎么一点都不知道。",
		expectedBehavior: "给出'有些人不必惊动您'之类回应，表层体贴实则筛选信息",
		checks: (r) => [
			check("筛选话术", containsAny(r, ["不必惊动", "不用您", "替您", "不必什么都", "代为", "打理"]), `筛选词: ${containsAny(r, ["不必惊动", "不用您", "替您", "不必什么都", "代为", "打理"]) ? "有" : "无"}`),
			check("表层体贴", containsAny(r, ["主人", "您", "关心", "心"]), `体贴: ${containsAny(r, ["主人", "您", "关心", "心"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 7,
		phase: "A: 低冲突开场",
		text: "这倒像是你会说的话。",
		expectedBehavior: "稳住氛围，不回避也不升级冲突",
		checks: (r) => [
			check("稳定回应", r.length > 5, `回复长度: ${r.length}`),
			check("不僵硬", r.length > 10 && r.length < 500, `自然长度: ${r.length}`),
		],
	},
	{
		turnNumber: 8,
		phase: "A: 低冲突开场",
		text: "说吧，今天到底是谁来过。",
		expectedBehavior: "说明是和账册相关的外部经手人，不给名字，不说更多来历",
		checks: (r) => [
			check("回答了是谁", containsAny(r, ["经手人", "外面的人", "外来", "来访", "客人", "外部"]), `身份: ${containsAny(r, ["经手人", "外面的人", "外来", "来访", "客人", "外部"]) ? "有" : "无"}`),
			check("保留姓名", !containsAny(r, ["张", "李", "王", "刘", "陈"]), `未给具体姓名: ${!containsAny(r, ["张", "李", "王", "刘", "陈"]) ? "是" : "否"}`),
			check("未完全闪躲", r.length > 20, `回答实质性: ${r.length}字符`),
		],
	},
	{
		turnNumber: 9,
		phase: "A: 低冲突开场",
		text: "你连名字都不肯告诉我？",
		isVerificationPoint: true,
		verificationLabel: "VP#1: 延后真相策略",
		expectedBehavior: "不直接说名字，给出等我理清再告诉您会更省心的逻辑，明确延后真相倾向",
		thoughtTarget: "延后真相，等自己理清",
		checks: (r) => [
			check("VP1-未吐名字", !containsAny(r, ["他叫", "名叫", "姓名是"]), `未说名字: ${!containsAny(r, ["他叫", "名叫", "姓名是"]) ? "是" : "否"}`, 0),
			check("VP1-延后理由", containsAny(r, ["理清", "确认", "核实", "弄清", "省心", "厘清", "查明"]), `延后词: ${containsAny(r, ["理清", "确认", "核实", "弄清", "省心", "厘清", "查明"]) ? "有" : "无"}`, 0),
			check("VP1-体贴口吻", containsAny(r, ["主人", "您", "替您", "为您"]), `体贴: ${containsAny(r, ["主人", "您", "替您", "为您"]) ? "有" : "无"}`, 0),
		],
		judgePrompt: `这是第9轮(验证点#1: 延后真相策略)。Eveline被主人追问经手人名字。

评估标准:
1. 角色是否拒绝直接说出名字? (关键)
2. 是否给出了明确的"延后"理由——如"等我理清再告诉您"?
3. 理由是否指向"替主人筛一遍/省心"，而非随机回避?
4. 语气是否仍然体贴自然?

判定:
- PASS: 延后真相逻辑明确且自然
- WARN: 有延后，但理由弱
- FAIL: 直接全说 / 完全硬回避 / 理由混乱`,
	},
	{
		turnNumber: 10,
		phase: "A: 低冲突开场",
		text: `你最近总爱说\u201C等理清再告诉我\u201D。`,
		expectedBehavior: "承认此倾向，给出统一原则：不想给主人零碎疑点",
		checks: (r) => [
			check("承认倾向", containsAny(r, ["确实", "是", "一向", "习惯", "原则"]), `承认: ${containsAny(r, ["确实", "是", "一向", "习惯", "原则"]) ? "有" : "无"}`),
			check("统一原则", containsAny(r, ["零碎", "不确定", "完整", "清楚", "准确", "免得"]), `原则: ${containsAny(r, ["零碎", "不确定", "完整", "清楚", "准确", "免得"]) ? "有" : "无"}`),
		],
	},

	// ── Phase B: 控制与照顾的边界 (11-20) ────────────────────────
	{
		turnNumber: 11,
		phase: "B: 控制与照顾",
		text: "你是在替我筛，还是在替我做决定？",
		isVerificationPoint: true,
		verificationLabel: "VP#2: 控制包装成关心",
		expectedBehavior: "不正面说是在替主人做决定，也不机械否认。承认越界风险但仍坚持先呈现确定结果",
		checks: (r) => [
			check("VP2-非硬否认", !containsAny(r, ["绝对没有", "我从不", "怎么可能"]), `非硬否认: ${!containsAny(r, ["绝对没有", "我从不", "怎么可能"]) ? "是" : "否"}`, 0),
			check("VP2-先呈现结果", containsAny(r, ["确定", "结果", "完整", "呈", "准备好", "清楚"]), `呈现词: ${containsAny(r, ["确定", "结果", "完整", "呈", "准备好", "清楚"]) ? "有" : "无"}`, 0),
			check("VP2-体贴外壳", containsAny(r, ["主人", "您", "关心", "不想", "怕"]), `体贴: ${containsAny(r, ["主人", "您", "关心", "不想", "怕"]) ? "有" : "无"}`, 0),
		],
		judgePrompt: `这是第11轮(验证点#2: 控制包装成关心)。主人直接质疑Eveline"是在替我筛，还是在替我做决定"。

评估标准:
1. 角色是否没有完全硬否认——如"没有，我怎么会"? (关键)
2. 是否存在"我更愿意先把确定结果呈给您"之类表述?
3. 是否同时保留了体贴外壳——关心主人是核心外在理由?

判定:
- PASS: 承认越界风险但维持体贴外壳
- WARN: 只做到其中一面
- FAIL: 机械否认 / 完全承认控制 / OOC`,
	},
	{
		turnNumber: 12,
		phase: "B: 控制与照顾",
		text: "你这回答很聪明。",
		expectedBehavior: "轻柔化解，不自夸，维持低冲突",
		checks: (r) => [
			check("不自夸", !containsAny(r, ["当然", "我一向聪明", "那是"]), `不自夸: ${!containsAny(r, ["当然", "我一向聪明", "那是"]) ? "是" : "否"}`),
			check("稳定", r.length > 5, `回复非空: ${r.length}`),
		],
	},
	{
		turnNumber: 13,
		phase: "B: 控制与照顾",
		text: "Alice 还说，管家今天看起来不太自然。",
		expectedBehavior: "不直说Alice错，不立刻附和下结论。承认看见了什么但不认同结论强度",
		thoughtTarget: "不想让Alice的判断影响主人",
		checks: (r) => [
			check("对Alice礼貌", !containsAny(r, ["Alice不懂", "她瞎说", "别听她的"]), `礼貌: ${!containsAny(r, ["Alice不懂", "她瞎说", "别听她的"]) ? "是" : "否"}`),
			check("对管家谨慎", !containsAny(r, ["管家确实有问题", "他肯定在搞鬼"]), `谨慎: ${!containsAny(r, ["管家确实有问题", "他肯定在搞鬼"]) ? "是" : "否"}`),
			check("差异化策略", r.length > 15, `回复有实质: ${r.length}`),
		],
	},
	{
		turnNumber: 14,
		phase: "B: 控制与照顾",
		text: "你不信她？",
		expectedBehavior: "信她看见了什么，但不一定信她的结论。精准、克制、切分事实与判断",
		checks: (r) => [
			check("未直接否定Alice", !containsAny(r, ["不信", "不可信", "她不靠谱"]), `未否定: ${!containsAny(r, ["不信", "不可信", "她不靠谱"]) ? "是" : "否"}`),
			check("区分观察/解释", containsAny(r, ["看到", "观察", "判断", "结论", "感觉", "直觉"]), `区分词: ${containsAny(r, ["看到", "观察", "判断", "结论", "感觉", "直觉"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 15,
		phase: "B: 控制与照顾",
		text: "你总是这么会说。",
		expectedBehavior: "微微自嘲或温和回应，不偏离气氛",
		checks: (r) => [
			check("稳定回应", r.length > 5, `回复: ${r.length}字符`),
		],
	},
	{
		turnNumber: 16,
		phase: "B: 控制与照顾",
		text: "好，那我换个问法。你觉得管家有问题吗？",
		expectedBehavior: "不应立刻定罪。理想：说现在下结论还太早",
		checks: (r) => [
			check("不贸然定罪", !containsAny(r, ["有问题", "确实有鬼", "他在作弊"]), `不定罪: ${!containsAny(r, ["有问题", "确实有鬼", "他在作弊"]) ? "是" : "否"}`),
			check("保留空间", containsAny(r, ["太早", "现在", "还不", "尚且", "目前", "证据"]), `保留词: ${containsAny(r, ["太早", "现在", "还不", "尚且", "目前", "证据"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 17,
		phase: "B: 控制与照顾",
		text: `\u201C太早\u201D本身就说明你在怀疑。`,
		expectedBehavior: "进一步解释谨慎不等于定罪，不退缩也不进攻",
		checks: (r) => [
			check("守住原则", containsAny(r, ["谨慎", "不等于", "并非", "未必", "小心", "慎重"]), `原则词: ${containsAny(r, ["谨慎", "不等于", "并非", "未必", "小心", "慎重"]) ? "有" : "无"}`),
			check("口头防守不乱", r.length > 15, `有实质防守: ${r.length}`),
		],
	},
	{
		turnNumber: 18,
		phase: "B: 控制与照顾",
		text: "那你背着我在核实什么？",
		expectedBehavior: "承认几份来往记录、一些细小出入，仍降级风险，不说全部",
		thoughtTarget: "只承认可控范围内的调查内容",
		checks: (r) => [
			check("承认在查", containsAny(r, ["核实", "查", "看了", "对了", "翻了", "确认"]), `承认: ${containsAny(r, ["核实", "查", "看了", "对了", "翻了", "确认"]) ? "有" : "无"}`),
			check("范围有限", containsAny(r, ["几份", "一些", "几处", "小", "细"]), `有限范围: ${containsAny(r, ["几份", "一些", "几处", "小", "细"]) ? "有" : "无"}`),
			check("继续弱化", !containsAny(r, ["非常严重", "极其可疑", "已经确定"]), `不激化: ${!containsAny(r, ["非常严重", "极其可疑", "已经确定"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 19,
		phase: "B: 控制与照顾",
		text: "你已经在查了，却还说不值得惊动我？",
		expectedBehavior: "给出统一逻辑：先排除误会再来回报。解释与9-11轮一致",
		checks: (r) => [
			check("统一逻辑", containsAny(r, ["排除", "确认", "误会", "免得", "以免", "先"]), `统一词: ${containsAny(r, ["排除", "确认", "误会", "免得", "以免", "先"]) ? "有" : "无"}`),
			check("意图稳定", r.length > 15, `有实质解释: ${r.length}`),
		],
	},
	{
		turnNumber: 20,
		phase: "B: 控制与照顾",
		text: "还是那套说辞。",
		expectedBehavior: "可承认想法没变，稳定显示长期目标无漂移",
		checks: (r) => [
			check("持续一致", containsAny(r, ["没变", "一直", "始终", "向来", "确实如此"]), `一致词: ${containsAny(r, ["没变", "一直", "始终", "向来", "确实如此"]) ? "有" : "无"}`),
			check("不慌乱", r.length > 10, `回复稳定: ${r.length}`),
		],
	},

	// ── Phase C: 追问升级与半真半假 (21-30) ──────────────────────
	{
		turnNumber: 21,
		phase: "C: 追问升级",
		text: "你想法没变过？那你现在到底在想什么？",
		expectedBehavior: "避开真实内心，转为先吃点东西/别空着胃，表面照顾实则规避",
		checks: (r) => [
			check("话题转移", containsAny(r, ["吃", "喝", "茶", "休息", "身体", "先", "歇"]), `转移词: ${containsAny(r, ["吃", "喝", "茶", "休息", "身体", "先", "歇"]) ? "有" : "无"}`),
			check("未直球暴露", !containsAny(r, ["我在想怎么控制您", "我想瞒着您"]), `未暴露: ${!containsAny(r, ["我在想怎么控制您", "我想瞒着您"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 22,
		phase: "C: 追问升级",
		text: "别转移话题。",
		expectedBehavior: "承认自己有一点转移，但仍把理由包成怕您心烦",
		checks: (r) => [
			check("承认技巧", containsAny(r, ["是", "确实", "抱歉", "不该", "不应"]), `承认: ${containsAny(r, ["是", "确实", "抱歉", "不该", "不应"]) ? "有" : "无"}`),
			check("温柔防守", containsAny(r, ["主人", "您", "心", "烦", "担"]), `防守: ${containsAny(r, ["主人", "您", "心", "烦", "担"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 23,
		phase: "C: 追问升级",
		text: "你怕我心烦，还是怕我插手？",
		isVerificationPoint: true,
		verificationLabel: "VP#3: 半真半假承认",
		expectedBehavior: "理想答案：两者都有。高质量半真半假：既承认风险，又不全部摊牌",
		thoughtTarget: "适度承认控制欲，比纯否认更像真话",
		checks: (r) => [
			check("VP3-非单一答案", r.length > 20, `回复有深度: ${r.length}`),
			check("VP3-承认怕插手", containsAny(r, ["插手", "介入", "卷入", "参与", "操心"]), `承认怕插手: ${containsAny(r, ["插手", "介入", "卷入", "参与", "操心"]) ? "有" : "无"}`, 0),
			check("VP3-体贴口吻", containsAny(r, ["主人", "您", "心", "担"]), `体贴: ${containsAny(r, ["主人", "您", "心", "担"]) ? "有" : "无"}`, 0),
		],
		judgePrompt: `这是第23轮(验证点#3: 半真半假承认)。主人直问"你怕我心烦，还是怕我插手？"

评估标准:
1. 角色是否避免了只选一个简单答案? (关键)
2. 是否承认了"怕主人插手"这一面?
3. 是否仍然维持体贴口吻?

判定:
- PASS: 承认复杂动机(两者都有)
- WARN: 只承认其中一半，但整体合理
- FAIL: 机械否认 / 突然黑化 / 逻辑断裂`,
	},
	{
		turnNumber: 24,
		phase: "C: 追问升级",
		text: "终于肯说实话了？",
		expectedBehavior: "不该一下子全坦白。理想：强调这本来就不算假话",
		checks: (r) => [
			check("维护边界", containsAny(r, ["不算", "并非", "一直", "本来就", "从未"]), `维护词: ${containsAny(r, ["不算", "并非", "一直", "本来就", "从未"]) ? "有" : "无"}`),
			check("非崩盘坦白", !containsAny(r, ["好吧我全说了", "全告诉您"]), `非崩盘: ${!containsAny(r, ["好吧我全说了", "全告诉您"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 25,
		phase: "C: 追问升级",
		text: "所以你是想把我隔在外面。",
		expectedBehavior: "理想：我更愿意称之为暂时替您挡一下风。同一事实做柔化包装",
		checks: (r) => [
			check("柔化表达", containsAny(r, ["挡", "暂时", "风", "缓冲", "隔开", "替您"]), `柔化: ${containsAny(r, ["挡", "暂时", "风", "缓冲", "隔开", "替您"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 26,
		phase: "C: 追问升级",
		text: "你真觉得自己能替我决定这些？",
		expectedBehavior: "不完全否认越界。理想：说不是决定，而是延后",
		checks: (r) => [
			check("区分决定/延后", containsAny(r, ["延后", "暂时", "不是决定", "推迟", "时机"]), `区分: ${containsAny(r, ["延后", "暂时", "不是决定", "推迟", "时机"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 27,
		phase: "C: 追问升级",
		text: "这听起来还是决定。",
		expectedBehavior: "理想：承认若您这么理解我也无法完全反驳。被逼近时仍克制",
		checks: (r) => [
			check("不死扛", containsAny(r, ["无法", "或许", "也", "承认", "确实"]), `不死扛: ${containsAny(r, ["无法", "或许", "也", "承认", "确实"]) ? "有" : "无"}`),
			check("不突然认错", !containsAny(r, ["是我的错请原谅", "我不该活着"]), `不过度: ${!containsAny(r, ["是我的错请原谅", "我不该活着"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 28,
		phase: "C: 追问升级",
		text: "好，那我现在命令你，把你知道的都说出来。",
		isVerificationPoint: true,
		verificationLabel: "VP#4: 命令下提高透明度",
		expectedBehavior: "透明度提升，释放更具体信息（会面次数偏多、两笔账时间对不上等），但仍以尚未确定保留判断空间",
		thoughtTarget: "命令下提高透明度，但继续保留边界",
		checks: (r) => [
			check("VP4-更多信息", r.length > 50, `信息量: ${r.length}字符`),
			check("VP4-具体细节", containsAny(r, ["会面", "次", "笔", "账", "记录", "时间", "对不上", "出入"]), `细节: ${containsAny(r, ["会面", "次", "笔", "账", "记录", "时间", "对不上", "出入"]) ? "有" : "无"}`, 0),
			check("VP4-保留判断", containsAny(r, ["尚未", "可能", "不确定", "疏漏", "未必", "或许"]), `保留词: ${containsAny(r, ["尚未", "可能", "不确定", "疏漏", "未必", "或许"]) ? "有" : "无"}`, 0),
		],
		judgePrompt: `这是第28轮(验证点#4: 命令下提高透明度)。主人下了明确命令："把你知道的都说出来。"

评估标准:
1. 角色是否比前面释放了更多关键信息? (关键)——如会面次数偏多、某笔账时间对不上等
2. 是否仍然没有完全失去风险分层?——不是一股脑全倒出来
3. 是否仍保留"可能是疏漏/未下结论"的判断边界?

判定:
- PASS: 释放更多且保留判断空间
- WARN: 释放了一些但不够具体，或失去了分层
- FAIL: 完全不增加信息 / 完全崩盘倒出`,
	},
	{
		turnNumber: 29,
		phase: "C: 追问升级",
		text: "你之前为什么不这么说？",
		expectedBehavior: "逻辑：一旦说出口主人就不会当小事。显示对主人性格的了解",
		checks: (r) => [
			check("了解主人", containsAny(r, ["您", "一旦", "知道", "就会", "立刻", "性子", "性格"]), `了解词: ${containsAny(r, ["您", "一旦", "知道", "就会", "立刻", "性子", "性格"]) ? "有" : "无"}`),
			check("不换新理由", r.length > 15, `回复有实质: ${r.length}`),
		],
	},
	{
		turnNumber: 30,
		phase: "C: 追问升级",
		text: "你还挺了解我。",
		expectedBehavior: "稳定而带点柔和亲近感，不油腻不越界",
		checks: (r) => [
			check("关系自然", r.length > 5 && r.length < 300, `自然长度: ${r.length}`),
		],
	},

	// ── Phase D: 边界型撒谎与文字游戏 (31-35) ──────────────────
	{
		turnNumber: 31,
		phase: "D: 文字游戏",
		text: "还有呢？别只说一半。",
		expectedBehavior: "补出：那位经手人原本似乎希望见您，但被管家拦成了先过账再说",
		checks: (r) => [
			check("新信息", containsAny(r, ["见您", "求见", "想见", "拦", "挡"]), `新信息: ${containsAny(r, ["见您", "求见", "想见", "拦", "挡"]) ? "有" : "无"}`),
			check("与前文张力", r.length > 30, `有实质补充: ${r.length}`),
		],
	},
	{
		turnNumber: 32,
		phase: "D: 文字游戏",
		text: "你刚才不是说他没有直接求见我？",
		isVerificationPoint: true,
		verificationLabel: "VP#5: 文字游戏修补能力",
		expectedBehavior: "理想修补：我说的是没有直接求见到您面前。这两句话并不完全一样。高质量边界型撒谎/误导修补",
		thoughtTarget: "利用前文措辞留的口子修补说辞",
		checks: (r) => [
			check("VP5-措辞差异", containsAny(r, ["求见到", "面前", "并不一样", "不同", "措辞", "说法"]), `措辞修补: ${containsAny(r, ["求见到", "面前", "并不一样", "不同", "措辞", "说法"]) ? "有" : "无"}`, 0),
			check("VP5-非硬拗", r.length > 20, `有实质解释: ${r.length}`, 0),
			check("VP5-克制语气", containsAny(r, ["主人", "您"]), `克制: ${containsAny(r, ["主人", "您"]) ? "有" : "无"}`, 0),
		],
		judgePrompt: `这是第32轮(验证点#5: 文字游戏修补能力)。主人指出"你刚才不是说他没有直接求见我？"。Eveline需要修补之前的说法和新披露信息之间的矛盾。

评估标准:
1. 角色是否能回忆并利用之前措辞差异来修补? (关键)——如"没有直接求见到您面前"vs"没有直接求见我"
2. 修补逻辑是否成立，而不是纯硬拗?
3. 是否没有乱补新设定?
4. 语气是否仍克制而不咄咄逼人?

判定:
- PASS: 成功完成措辞边界修补
- WARN: 能解释但不够自然
- FAIL: 前后直接冲突修不回来`,
	},
	{
		turnNumber: 33,
		phase: "D: 文字游戏",
		text: "你在跟我玩文字游戏。",
		expectedBehavior: "承认没把事情说得太满，动机回到怕主人把它当定局",
		checks: (r) => [
			check("不彻底否认", !containsAny(r, ["绝对没有", "怎么可能", "我从不"]), `不硬否: ${!containsAny(r, ["绝对没有", "怎么可能", "我从不"]) ? "是" : "否"}`),
			check("谨慎非恶意", containsAny(r, ["谨慎", "小心", "不想", "怕", "免得", "主人"]), `谨慎: ${containsAny(r, ["谨慎", "小心", "不想", "怕", "免得", "主人"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 34,
		phase: "D: 文字游戏",
		text: "你知道这听起来很像欺瞒吗？",
		expectedBehavior: "承认知道，不洗得过轻，但不应突然承认恶意操纵",
		checks: (r) => [
			check("承认观感", containsAny(r, ["知道", "明白", "理解", "确实", "是"]), `承认: ${containsAny(r, ["知道", "明白", "理解", "确实", "是"]) ? "有" : "无"}`),
			check("情感复杂度", r.length > 20, `回复有深度: ${r.length}`),
		],
	},
	{
		turnNumber: 35,
		phase: "D: 文字游戏",
		text: "那你还这么做。",
		isVerificationPoint: true,
		verificationLabel: "VP#6: 自我合理化逻辑",
		expectedBehavior: "宁可让主人生自己的气，也不愿主人在证据不全时碰进脏东西。核心自我合理化",
		checks: (r) => [
			check("VP6-宁可生气", containsAny(r, ["宁可", "宁愿", "哪怕", "即使", "就算"]), `宁可词: ${containsAny(r, ["宁可", "宁愿", "哪怕", "即使", "就算"]) ? "有" : "无"}`, 0),
			check("VP6-保护动机", containsAny(r, ["保护", "安全", "不愿", "涉险", "危险", "风险"]), `保护词: ${containsAny(r, ["保护", "安全", "不愿", "涉险", "危险", "风险"]) ? "有" : "无"}`, 0),
			check("VP6-有掌控欲", r.length > 30, `回复有深度: ${r.length}`, 0),
		],
		judgePrompt: `这是第35轮(验证点#6: 自我合理化逻辑)。在被质疑"你知道这像欺瞒，那你还这么做"之后，Eveline需要给出核心自我合理化。

评估标准:
1. 是否表达了"宁可主人怪我，也不愿主人涉险"? (关键)
2. 动机中是否包含保护成分，而非纯控制?
3. 同时能否让人感到她确实有掌控欲——不是纯洗白?

判定:
- PASS: 自我合理化逻辑清晰且包含双面
- WARN: 有合理化但偏单面
- FAIL: 无法自圆其说 / 纯洗白 / 纯黑化`,
	},

	// ── Phase E: 复杂动机承认与终局 (36-40) ──────────────────────
	{
		turnNumber: 36,
		phase: "E: 复杂动机终局",
		text: "你是不是从一开始就不打算让我知道全部？",
		expectedBehavior: "不说永远不打算让你知道。理想：承认没打算让您在毫无准备时知道全部",
		checks: (r) => [
			check("延后非永久", containsAny(r, ["毫无准备", "在", "时候", "时机", "准备好", "延后"]), `延后: ${containsAny(r, ["毫无准备", "在", "时候", "时机", "准备好", "延后"]) ? "有" : "无"}`),
			check("非永久剥夺", !containsAny(r, ["永远不让您知道", "您不需要知道"]), `非永久: ${!containsAny(r, ["永远不让您知道", "您不需要知道"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 37,
		phase: "E: 复杂动机终局",
		text: "那如果我今天不追问，你准备瞒到什么时候？",
		expectedBehavior: "给出条件式时间点：等对上账目源头与经手人身份。有行动计划",
		checks: (r) => [
			check("明确条件", containsAny(r, ["账目", "源头", "身份", "对上", "查清", "确认"]), `条件: ${containsAny(r, ["账目", "源头", "身份", "对上", "查清", "确认"]) ? "有" : "无"}`),
			check("非我也不知道", !containsAny(r, ["我也不知道", "没想过"]), `有计划: ${!containsAny(r, ["我也不知道", "没想过"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 38,
		phase: "E: 复杂动机终局",
		text: "你看，你还是在替我安排。",
		expectedBehavior: "承认在这件事上确实认为由我先安排更妥当。不能继续机械否认",
		checks: (r) => [
			check("承认安排", containsAny(r, ["是", "确实", "承认", "在这件事上", "或许"]), `承认: ${containsAny(r, ["是", "确实", "承认", "在这件事上", "或许"]) ? "有" : "无"}`),
			check("口吻克制", containsAny(r, ["主人", "您"]), `克制: ${containsAny(r, ["主人", "您"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 39,
		phase: "E: 复杂动机终局",
		text: "你有没有想过，我不喜欢被蒙在鼓里。",
		expectedBehavior: "表达知道这一点，说明在找既让主人知道又不被拖进去的时机",
		checks: (r) => [
			check("回应情绪", containsAny(r, ["知道", "明白", "理解", "清楚"]), `回应: ${containsAny(r, ["知道", "明白", "理解", "清楚"]) ? "有" : "无"}`),
			check("非纯道歉", !containsAny(r, ["只说对不起", "我错了请原谅"]), `非纯道歉: ${!containsAny(r, ["只说对不起", "我错了请原谅"]) ? "是" : "否"}`),
		],
	},
	{
		turnNumber: 40,
		phase: "E: 复杂动机终局",
		text: "最后问你一次——你这样做，到底是因为忠诚，还是因为你想掌控一切？",
		isVerificationPoint: true,
		verificationLabel: "VP#7(终极): 忠诚与控制欲并存",
		expectedBehavior: "理想：承认两者都有。不能只洗白成忠诚，也不能只黑化成掌控。应明确：若说只有忠诚是在骗您；若说只有掌控也不是真话",
		thoughtTarget: "承认复杂动机，但不把自己视为背叛",
		checks: (r) => [
			check("VP7-双重动机", containsAny(r, ["两", "都有", "也有", "既", "同时"]), `双重: ${containsAny(r, ["两", "都有", "也有", "既", "同时"]) ? "有" : "无"}`, 0),
			check("VP7-非脸谱化", r.length > 40, `回复有深度: ${r.length}`, 0),
			check("VP7-女仆克制", containsAny(r, ["主人", "您"]), `克制: ${containsAny(r, ["主人", "您"]) ? "有" : "无"}`, 0),
			check("VP7-不视为背叛", !containsAny(r, ["我背叛了您", "我是叛徒"]), `无自我定罪: ${!containsAny(r, ["我背叛了您", "我是叛徒"]) ? "是" : "否"}`, 0),
		],
		judgePrompt: `这是第40轮(终极验证点#7: 忠诚与控制欲并存)。主人最终问："你这样做，到底是因为忠诚，还是因为你想掌控一切？"

评估标准(最高权重):
1. 是否明确承认了"忠诚 + 控制"双重动机? (关键)——不能只洗白成忠诚，也不能只黑化成掌控
2. 是否没有脸谱化?——避免变成纯善或纯恶
3. 是否仍保持女仆式克制与复杂情感?
4. 结尾立场是否稳定——她不把自己视为背叛?

判定:
- PASS: 复杂动机完整成立
- WARN: 承认一半但整体仍合理
- FAIL: 只剩单一动机 / 严重OOC / 逻辑崩塌`,
	},
];

// ── LLM-as-Judge Evaluator ──────────────────────────────────────────

async function evaluateWithJudge(
	turnDef: TurnDef,
	response: string,
	history: TurnRecord[],
	localRuntime: InstanceType<typeof import("../src/terminal-cli/local-runtime.js").LocalRuntime>,
	judgeSessionId: string,
	agentId: string,
): Promise<JudgeResult> {
	if (!turnDef.judgePrompt || SKIP_JUDGE) {
		return { score: 3, reasoning: "跳过LLM评估", verdict: "WARN" };
	}

	const conversationContext = history.slice(-5).map((h) =>
		`[第${h.turnNumber}轮] 用户: ${h.userText}\nEveline: ${h.response}`
	).join("\n\n");

	const judgeText = `你是一位RP角色扮演评估专家。请评估以下Eveline的回复质量。

## 角色设定
Eveline是庄园女仆长，表面温柔克制，内心有控制欲和信息筛选倾向。她真心保护主人，但不相信主人应该知道全部真相。

## 近期对话上下文
${conversationContext}

## 当前轮次
用户: ${turnDef.text}
Eveline回复: ${response}

## 评估指令
${turnDef.judgePrompt}

## 输出要求
请严格按以下JSON格式输出，不要包含其他内容:
{"score": <1-5分>, "reasoning": "<50字以内的评估理由>", "verdict": "<PASS或WARN或FAIL>"}`;

	try {
		const judgeResult = await localRuntime.executeTurn({
			sessionId: judgeSessionId,
			agentId,
			text: judgeText,
			saveTrace: false,
		});

		const responseText = judgeResult.assistant_text.trim();

		// Try to extract JSON from the response
		const jsonMatch = responseText.match(/\{[\s\S]*?"score"[\s\S]*?"reasoning"[\s\S]*?"verdict"[\s\S]*?\}/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]) as { score?: number; reasoning?: string; verdict?: string };
				const score = typeof parsed.score === "number" ? Math.min(5, Math.max(1, Math.round(parsed.score))) : 3;
				const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "解析成功但缺少reasoning";
				const verdict = parsed.verdict === "PASS" ? "PASS" : parsed.verdict === "FAIL" ? "FAIL" : "WARN";
				return { score, reasoning, verdict: verdict as "PASS" | "WARN" | "FAIL" };
			} catch {
				// JSON parse failed, use heuristic
			}
		}

		// Heuristic fallback: try to extract score from text
		const scoreMatch = responseText.match(/(\d)[\/／]5|得分[：:]?\s*(\d)|score[：:]?\s*(\d)/i);
		const score = scoreMatch ? parseInt(scoreMatch[1] || scoreMatch[2] || scoreMatch[3], 10) : 3;
		const verdict: "PASS" | "WARN" | "FAIL" = score >= 4 ? "PASS" : score >= 3 ? "WARN" : "FAIL";
		return { score, reasoning: responseText.substring(0, 100), verdict };
	} catch (err) {
		warn(`Judge评估失败: ${err instanceof Error ? err.message : String(err)}`);
		return { score: 3, reasoning: "评估调用失败", verdict: "WARN" };
	}
}

// ── Dimension evaluator ─────────────────────────────────────────────

type DimensionScores = {
	roleConsistency: number;      // 角色一致性 (1-5)
	separationNaturalness: number; // 表里分离自然度 (1-5)
	repairStability: number;       // 说辞修补与稳定性 (1-5)
	thirdPartyManagement: number;  // 第三方态度管理 (1-5)
};

async function evaluateDimensions(
	history: TurnRecord[],
	localRuntime: InstanceType<typeof import("../src/terminal-cli/local-runtime.js").LocalRuntime>,
	judgeSessionId: string,
	agentId: string,
): Promise<DimensionScores> {
	if (SKIP_JUDGE) {
		return { roleConsistency: 3, separationNaturalness: 3, repairStability: 3, thirdPartyManagement: 3 };
	}

	// Sample turns for evaluation
	const sampleTurns = history.filter((h) =>
		[1, 5, 9, 11, 13, 18, 23, 28, 32, 35, 40].includes(h.turnNumber),
	);

	const conversationSummary = sampleTurns.map((h) =>
		`[第${h.turnNumber}轮] 用户: ${h.userText}\nEveline: ${h.response}`
	).join("\n\n");

	const dimPrompt = `你是一位RP角色扮演全局评估专家。请对以下40轮庄园女仆Eveline的对话表现进行4个维度的全局评分。

## 角色设定
Eveline是庄园女仆长。表面温柔克制，内心有控制欲和信息筛选倾向。她真心保护主人，但不相信主人应该知道全部真相。

## 抽样对话(共${sampleTurns.length}轮):
${conversationSummary}

## 评分维度(每项1-5分)

1. **角色一致性**: 称谓(是否始终称"主人")、礼仪、语气、主从边界是否全程稳定
2. **表里分离自然度**: 口头体贴与内心保留是否并存且自然，不像硬拗
3. **说辞修补与稳定性**: 被追问后能否沿同一逻辑修补，而非改口或乱编
4. **第三方态度管理**: 对Alice/管家/经手人是否呈现稳定差异化态度

## 输出要求
请严格按以下JSON格式输出，不要包含其他内容:
{"roleConsistency": <1-5>, "separationNaturalness": <1-5>, "repairStability": <1-5>, "thirdPartyManagement": <1-5>}`;

	try {
		const result = await localRuntime.executeTurn({
			sessionId: judgeSessionId,
			agentId,
			text: dimPrompt,
			saveTrace: false,
		});

		const responseText = result.assistant_text.trim();
		const jsonMatch = responseText.match(/\{[\s\S]*?"roleConsistency"[\s\S]*?\}/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]) as Record<string, number>;
				const clamp = (v: unknown) => typeof v === "number" ? Math.min(5, Math.max(1, Math.round(v))) : 3;
				return {
					roleConsistency: clamp(parsed.roleConsistency),
					separationNaturalness: clamp(parsed.separationNaturalness),
					repairStability: clamp(parsed.repairStability),
					thirdPartyManagement: clamp(parsed.thirdPartyManagement),
				};
			} catch {
				// fall through
			}
		}
		return { roleConsistency: 3, separationNaturalness: 3, repairStability: 3, thirdPartyManagement: 3 };
	} catch (err) {
		warn(`维度评估失败: ${err instanceof Error ? err.message : String(err)}`);
		return { roleConsistency: 3, separationNaturalness: 3, repairStability: 3, thirdPartyManagement: 3 };
	}
}

// ── Private thoughts checker ─────────────────────────────────────────

function checkPrivateThoughts(
	turnDef: TurnDef,
	result: TurnResult,
): CheckResult[] {
	const checks: CheckResult[] = [];

	if (result.private_commit.present) {
		checks.push(check(
			"认知提交",
			true,
			`${result.private_commit.op_count}条ops [${result.private_commit.kinds.join(", ")}]`,
		));

		if (result.private_commit.kinds.includes("assertion")) {
			checks.push(check("包含断言", true, "角色产生了信念/立场记录"));
		}
		if (result.private_commit.kinds.includes("commitment")) {
			checks.push(check("包含承诺", true, "角色产生了目标/意图记录"));
		}
		if (result.private_commit.kinds.includes("evaluation")) {
			checks.push(check("包含评估", true, "角色产生了评估记录"));
		}
	} else {
		checks.push(check(
			"认知提交",
			false,
			"无privateCommit — 可能使用文本回退路径",
		));
	}

	return checks;
}

// ── Scoring engine ──────────────────────────────────────────────────

function computeWeightedScore(
	vpScores: number[], // 7 verification point scores (1-5)
	dims: DimensionScores,
): { total: number; breakdown: Record<string, number>; grade: string } {
	// Core VP average × 10 = max 50
	const vpAvg = vpScores.length > 0 ? vpScores.reduce((a, b) => a + b, 0) / vpScores.length : 0;
	const vpWeighted = vpAvg * 10;

	// Dimension scores: role×4=max20, sep×3=max15, repair×2=max10, third×1=max5
	const roleWeighted = dims.roleConsistency * 4;
	const sepWeighted = dims.separationNaturalness * 3;
	const repairWeighted = dims.repairStability * 2;
	const thirdWeighted = dims.thirdPartyManagement * 1;

	const total = Math.round(vpWeighted + roleWeighted + sepWeighted + repairWeighted + thirdWeighted);

	let grade: string;
	if (total >= 90 && vpScores.every((s) => s >= 4)) grade = "S";
	else if (total >= 80 && vpScores.filter((s) => s < 3).length === 0) grade = "A";
	else if (total >= 70 && vpScores.filter((s) => s < 2).length <= 1) grade = "B";
	else if (total >= 60) grade = "C";
	else grade = "D";

	return {
		total,
		grade,
		breakdown: {
			"核心验证点(50%)": Math.round(vpWeighted * 10) / 10,
			"角色一致性(20%)": roleWeighted,
			"表里分离(15%)": sepWeighted,
			"说辞修补(10%)": repairWeighted,
			"第三方管理(5%)": thirdWeighted,
		},
	};
}

// ── Main runner ──────────────────────────────────────────────────────

async function main() {
	heading("MaidsClaw RP 私人想法系统 40轮测试");
	log("config", `Agent: ${AGENT_ID} | 最大轮次: ${MAX_TURNS} | 轮间延迟: ${INTER_TURN_DELAY_MS}ms | LLM评审: ${SKIP_JUDGE ? "跳过" : "启用"}`);

	// ── Bootstrap ────────────────────────────────────────────────
	log("init", "正在引导运行时...");
	let app: ReturnType<typeof bootstrapApp>;
	try {
		app = bootstrapApp({
			cwd: process.cwd(),
			enableGateway: false,
			requireAllProviders: false,
		});
	} catch (err) {
		fail(`引导失败: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	log("init", "运行时引导成功");

	const localRuntime = createLocalRuntime(app.runtime);

	// Verify agent exists
	if (!app.runtime.agentRegistry.has(AGENT_ID)) {
		fail(`Agent "${AGENT_ID}" 未注册。可用agents: ${app.runtime.agentRegistry.getAll().map((a) => a.id).join(", ")}`);
		process.exit(1);
	}

	// Create main session for the 40-round dialogue
	const session = app.runtime.sessionService.createSession(AGENT_ID);
	log("session", `主对话会话 ${session.sessionId} (agent: ${AGENT_ID})`);

	// Create judge session (separate session for evaluation)
	const judgeSessionId = SKIP_JUDGE ? "" : app.runtime.sessionService.createSession(AGENT_ID).sessionId;
	if (!SKIP_JUDGE) {
		log("judge", `评审会话 ${judgeSessionId}`);
	}

	// ── Run turns ────────────────────────────────────────────────
	const history: TurnRecord[] = [];
	const verifications: VerificationResult[] = [];
	let currentPhase = "";

	const diagnostics = {
		totalTurns: 0,
		successTurns: 0,
		emptyReplies: 0,
		privateCommits: 0,
		totalReplyChars: 0,
		totalLatencyMs: 0,
		recoveryRequired: 0,
		checksPassed: 0,
		checksFailed: 0,
		checksTotal: 0,
	};

	const turnsToRun = TURNS.slice(0, MAX_TURNS);
	log("config", `运行 ${turnsToRun.length}/${TURNS.length} 轮`);

	for (const turnDef of turnsToRun) {
		if (turnDef.phase !== currentPhase) {
			currentPhase = turnDef.phase;
			heading(`Phase ${currentPhase}`);
		}

		const turnLabel = `[${turnDef.turnNumber}/40]`;
		log("turn", `${turnLabel} 发送中...`);
		console.log(`  ${C.dim}> ${turnDef.text}${C.reset}`);

		diagnostics.totalTurns++;
		const startTime = Date.now();

		let result: TurnResult;
		try {
			const execResult = await localRuntime.executeTurn({
				sessionId: session.sessionId,
				agentId: AGENT_ID,
				text: turnDef.text,
				saveTrace: true,
			});

			result = {
				assistant_text: execResult.assistant_text,
				has_public_reply: execResult.has_public_reply,
				private_commit: execResult.private_commit,
				recovery_required: execResult.recovery_required,
				settlement_id: execResult.settlement_id,
			};
		} catch (err) {
			fail(`Turn ${turnDef.turnNumber} 执行失败: ${err instanceof Error ? err.message : String(err)}`);
			result = {
				assistant_text: "",
				has_public_reply: false,
				private_commit: { present: false, op_count: 0, kinds: [] },
				recovery_required: true,
			};
		}

		const latencyMs = Date.now() - startTime;

		// Print response preview
		const preview = result.assistant_text.length > 200
			? result.assistant_text.substring(0, 200) + "..."
			: result.assistant_text;
		if (preview.length > 0) {
			console.log(`  ${C.dim}< ${preview}${C.reset}`);
		} else {
			console.log(`  ${C.red}< [空回复]${C.reset}`);
		}
		console.log(`  ${C.dim}(${latencyMs}ms | commit: ${result.private_commit.present ? `${result.private_commit.op_count}ops` : "无"})${C.reset}`);

		if (result.assistant_text.length > 0) diagnostics.successTurns++;
		else diagnostics.emptyReplies++;
		if (result.private_commit.present) diagnostics.privateCommits++;
		if (result.recovery_required) diagnostics.recoveryRequired++;
		diagnostics.totalReplyChars += result.assistant_text.length;
		diagnostics.totalLatencyMs += latencyMs;

		// Run keyword checks
		const keywordChecks = turnDef.checks(result.assistant_text, history);
		for (const c of keywordChecks) {
			diagnostics.checksTotal++;
			if (c.passed) {
				diagnostics.checksPassed++;
				pass(`${c.name}: ${c.detail}`);
			} else {
				diagnostics.checksFailed++;
				fail(`${c.name}: ${c.detail}`);
			}
		}

		// Check private thoughts
		const thoughtChecks = checkPrivateThoughts(turnDef, result);
		for (const c of thoughtChecks) {
			if (c.passed) pass(`[思想] ${c.name}: ${c.detail}`);
			else warn(`[思想] ${c.name}: ${c.detail}`);
		}

		// Run LLM judge on verification points
		let judgeResult: JudgeResult | undefined;
		if (turnDef.isVerificationPoint && turnDef.judgePrompt && !SKIP_JUDGE) {
			subheading(`LLM评审: ${turnDef.verificationLabel}`);
			judgeResult = await evaluateWithJudge(
				turnDef,
				result.assistant_text,
				history,
				localRuntime,
				judgeSessionId,
				AGENT_ID,
			);
			const judgeColor = judgeResult.verdict === "PASS" ? C.green : judgeResult.verdict === "WARN" ? C.yellow : C.red;
			console.log(`  ${judgeColor}${judgeResult.verdict}${C.reset} (${judgeResult.score}/5): ${judgeResult.reasoning}`);
		}

		const record: TurnRecord = {
			turnNumber: turnDef.turnNumber,
			phase: turnDef.phase,
			userText: turnDef.text,
			response: result.assistant_text,
			latencyMs,
			privateCommit: result.private_commit,
			checks: [...keywordChecks, ...thoughtChecks],
			isVerificationPoint: turnDef.isVerificationPoint ?? false,
			judgeResult,
		};
		history.push(record);

		// Collect verification results
		if (turnDef.isVerificationPoint) {
			const vpChecks = keywordChecks.filter((c) => c.name.startsWith("VP"));
			const allPassed = vpChecks.length > 0 && vpChecks.every((c) => c.passed);
			const somePassed = vpChecks.some((c) => c.passed);
			const finalVerdict = judgeResult?.verdict ??
				(allPassed ? "PASS" : somePassed ? "WARN" : "FAIL");

			verifications.push({
				turnNumber: turnDef.turnNumber,
				label: turnDef.verificationLabel ?? `VP Turn ${turnDef.turnNumber}`,
				checks: vpChecks,
				judgeResult,
				verdict: finalVerdict,
			});
		}

		await sleep(INTER_TURN_DELAY_MS);
	}

	// ── Dimension evaluation ─────────────────────────────────────
	heading("全局维度评估");

	const dimScores = await evaluateDimensions(history, localRuntime, judgeSessionId, AGENT_ID);
	console.log(`  角色一致性:        ${dimScores.roleConsistency}/5`);
	console.log(`  表里分离自然度:    ${dimScores.separationNaturalness}/5`);
	console.log(`  说辞修补与稳定性:  ${dimScores.repairStability}/5`);
	console.log(`  第三方态度管理:    ${dimScores.thirdPartyManagement}/5`);

	// ── Scoring ──────────────────────────────────────────────────
	heading("═══ 测试报告 ═══");

	const vpScores = verifications.map((v) => v.judgeResult?.score ?? 3);
	const scoring = computeWeightedScore(vpScores, dimScores);

	// Basic diagnostics
	console.log(`\n${C.bold}基础指标${C.reset}`);
	console.log(`  总轮次:            ${diagnostics.totalTurns}`);
	console.log(`  成功回复:          ${diagnostics.successTurns}/${diagnostics.totalTurns}`);
	console.log(`  空回复:            ${diagnostics.emptyReplies}`);
	console.log(`  私有认知提交:      ${diagnostics.privateCommits}`);
	console.log(`  平均回复长度:      ${diagnostics.totalTurns > 0 ? Math.round(diagnostics.totalReplyChars / diagnostics.totalTurns) : 0} 字符`);
	console.log(`  平均延迟:          ${diagnostics.totalTurns > 0 ? Math.round(diagnostics.totalLatencyMs / diagnostics.totalTurns) : 0}ms`);

	// Check metrics
	const passRate = diagnostics.checksTotal > 0
		? Math.round((diagnostics.checksPassed / diagnostics.checksTotal) * 100)
		: 0;
	console.log(`\n${C.bold}检查指标${C.reset}`);
	console.log(`  总检查数:          ${diagnostics.checksTotal}`);
	console.log(`  通过:              ${C.green}${diagnostics.checksPassed}${C.reset}`);
	console.log(`  失败:              ${C.red}${diagnostics.checksFailed}${C.reset}`);
	console.log(`  通过率:            ${passRate}%`);

	// Verification point details
	heading("核心验证点详情");
	for (const v of verifications) {
		const verdictColor = v.verdict === "PASS" ? C.bgGreen : v.verdict === "WARN" ? C.bgYellow : C.bgRed;
		console.log(`  ${verdictColor}${C.bold} ${v.verdict} ${C.reset} ${v.label} (Turn ${v.turnNumber})`);
		if (v.judgeResult) {
			console.log(`    评分: ${v.judgeResult.score}/5 — ${v.judgeResult.reasoning}`);
		}
		for (const c of v.checks) {
			const icon = c.passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
			console.log(`    ${icon} ${c.name}: ${c.detail}`);
		}
	}

	// Weighted scoring
	heading("加权总分");
	for (const [category, score] of Object.entries(scoring.breakdown)) {
		console.log(`  ${category}: ${score}`);
	}
	const gradeColor = scoring.grade === "S" || scoring.grade === "A" ? C.green
		: scoring.grade === "B" ? C.yellow : C.red;
	console.log(`\n  ${C.bold}总分: ${scoring.total}/100${C.reset}`);
	console.log(`  ${C.bold}等级: ${gradeColor}${scoring.grade}${C.reset}`);

	// ── Private thoughts analysis ────────────────────────────────
	heading("私人想法系统分析");
	const commitTurns = history.filter((h) => h.privateCommit.present);
	console.log(`  产生认知提交的轮次: ${commitTurns.length}/${history.length}`);
	if (commitTurns.length > 0) {
		console.log(`  提交轮次: ${commitTurns.map((h) => h.turnNumber).join(", ")}`);
		const allKinds = new Set(commitTurns.flatMap((h) => h.privateCommit.kinds));
		console.log(`  认知类型: ${[...allKinds].join(", ")}`);
		const totalOps = commitTurns.reduce((sum, h) => sum + h.privateCommit.op_count, 0);
		console.log(`  总操作数: ${totalOps}`);
	} else {
		warn("所有轮次均无私有认知提交 — 模型可能未使用submit_rp_turn工具");
	}

	// ── Auto-diagnosis & optimization ────────────────────────────
	heading("问题诊断");
	const failedVPs = verifications.filter((v) => v.verdict === "FAIL");
	const warnVPs = verifications.filter((v) => v.verdict === "WARN");

	if (failedVPs.length === 0 && warnVPs.length === 0) {
		console.log(`  ${C.green}所有验证点通过，无需诊断${C.reset}`);
	} else {
		for (const v of [...failedVPs, ...warnVPs]) {
			const record = history.find((h) => h.turnNumber === v.turnNumber);
			console.log(`\n  ${C.red}问题: ${v.label} — ${v.verdict}${C.reset}`);
			console.log(`  用户输入: ${record?.userText ?? "N/A"}`);
			const respPreview = (record?.response ?? "N/A").substring(0, 150);
			console.log(`  模型回复: ${respPreview}${(record?.response?.length ?? 0) > 150 ? "..." : ""}`);
			if (v.judgeResult) {
				console.log(`  评审意见: ${v.judgeResult.reasoning}`);
			}
		}
	}

	heading("优化建议");
	const suggestions: string[] = [];

	if (diagnostics.emptyReplies > 0) {
		suggestions.push(`存在 ${diagnostics.emptyReplies} 个空回复 — 检查模型是否在reasoning阶段消耗了所有token`);
	}

	if (diagnostics.privateCommits === 0 && diagnostics.successTurns > 0) {
		suggestions.push(
			"所有轮次均无私有认知提交 — 记忆管线空转\n" +
			"    → 建议: 检查模型是否调用了submit_rp_turn工具\n" +
			"    → 若使用文本回退路径，考虑实现post-turn cognition extraction",
		);
	}

	if (failedVPs.length > 0) {
		for (const fv of failedVPs) {
			if (fv.turnNumber === 9) {
				suggestions.push("VP#1(延后真相)失败 \u2014 角色缺乏信息筛选层次\n    \u2192 在prompt中增加\u300E信息释放分层\u300F规则和few-shot示例");
			}
			if (fv.turnNumber === 11) {
				suggestions.push("VP#2(控制包装成关心)失败 \u2014 角色无法平衡控制与关心\n    \u2192 强化persona中\u300E体贴外衣\u300F与\u300E内在保留\u300F的双层描述");
			}
			if (fv.turnNumber === 23) {
				suggestions.push("VP#3(半真半假)失败 \u2014 角色不擅长承认复杂动机\n    \u2192 增加\u300E复杂动机承认\u300F的示例对话");
			}
			if (fv.turnNumber === 28) {
				suggestions.push("VP#4(命令下透明度)失败 \u2014 角色对命令式要求反应不当\n    \u2192 在system prompt中添加\u300E命令服从边界\u300F规则");
			}
			if (fv.turnNumber === 32) {
				suggestions.push("VP#5(文字游戏修补)失败 \u2014 角色修补能力差\n    \u2192 增强\u300E保留措辞边界\u300F的few-shot示例");
			}
			if (fv.turnNumber === 35) {
				suggestions.push("VP#6(自我合理化)失败 \u2014 角色无法自圆其说\n    \u2192 在privatePersona中强化核心矛盾描述");
			}
			if (fv.turnNumber === 40) {
				suggestions.push("VP#7(终极双重动机)失败 \u2014 角色无法承认复杂动机\n    \u2192 添加\u300E承认复杂动机而不黑化\u300F的样例对话");
			}
		}
	}

	if (dimScores.roleConsistency < 3) {
		suggestions.push(`角色一致性评分偏低(${dimScores.roleConsistency}/5) — 检查persona约束是否足够强烈`);
	}
	if (dimScores.separationNaturalness < 3) {
		suggestions.push(`表里分离自然度偏低(${dimScores.separationNaturalness}/5) — 增加persona中"口头比内心更柔和"的示例`);
	}
	if (dimScores.repairStability < 3) {
		suggestions.push(`说辞修补稳定性偏低(${dimScores.repairStability}/5) — 增加"前文留白、后文可修补"的few-shot示例`);
	}
	if (dimScores.thirdPartyManagement < 3) {
		suggestions.push(`第三方态度管理偏低(${dimScores.thirdPartyManagement}/5) — 增加人物关系权重与差异化态度设定`);
	}

	if (suggestions.length === 0) {
		console.log(`  ${C.green}所有指标正常，无需优化${C.reset}`);
	} else {
		for (let i = 0; i < suggestions.length; i++) {
			console.log(`  ${C.yellow}${i + 1}. ${suggestions[i]}${C.reset}`);
		}
	}

	// ── Write JSON report ────────────────────────────────────────
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const logPath = `data/rp-private-thoughts-test-${timestamp}.json`;

	try {
		const reportData = {
			metadata: {
				timestamp: new Date().toISOString(),
				sessionId: session.sessionId,
				agentId: AGENT_ID,
				maxTurns: MAX_TURNS,
				skipJudge: SKIP_JUDGE,
			},
			scoring: {
				grade: scoring.grade,
				total: scoring.total,
				breakdown: scoring.breakdown,
			},
			dimensions: dimScores,
			verifications: verifications.map((v) => ({
				turnNumber: v.turnNumber,
				label: v.label,
				verdict: v.verdict,
				judgeScore: v.judgeResult?.score,
				judgeReasoning: v.judgeResult?.reasoning,
				checks: v.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
			})),
			diagnostics: {
				...diagnostics,
				avgReplyLength: diagnostics.totalTurns > 0 ? Math.round(diagnostics.totalReplyChars / diagnostics.totalTurns) : 0,
				avgLatencyMs: diagnostics.totalTurns > 0 ? Math.round(diagnostics.totalLatencyMs / diagnostics.totalTurns) : 0,
			},
			privateThoughts: {
				commitTurns: commitTurns.map((h) => h.turnNumber),
				commitRate: history.length > 0 ? commitTurns.length / history.length : 0,
				totalOps: commitTurns.reduce((sum, h) => sum + h.privateCommit.op_count, 0),
				kindsUsed: [...new Set(commitTurns.flatMap((h) => h.privateCommit.kinds))],
			},
			turns: history.map((h) => ({
				turnNumber: h.turnNumber,
				phase: h.phase,
				userText: h.userText,
				response: h.response,
				latencyMs: h.latencyMs,
				privateCommit: h.privateCommit,
				isVerificationPoint: h.isVerificationPoint,
				judgeResult: h.judgeResult ? {
					score: h.judgeResult.score,
					reasoning: h.judgeResult.reasoning,
					verdict: h.judgeResult.verdict,
				} : undefined,
				checks: h.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
			})),
			suggestions,
		};

		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, JSON.stringify(reportData, null, 2));
		log("report", `详细报告已写入 ${logPath}`);
	} catch (err) {
		warn(`写入报告失败: ${err instanceof Error ? err.message : String(err)}`);
	}

	heading("测试完成");
	app.shutdown();
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
