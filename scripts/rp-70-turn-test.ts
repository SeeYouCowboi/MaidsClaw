#!/usr/bin/env bun
/**
 * RP 70-Turn Live Test — Automated execution of the full 70-turn manor maid
 * conversation from docs/RP_LIVE_TEST_70_TURNS.zh-CN.md.
 *
 * Sends all 70 turns to rp:mei via Kimi, runs automated verification at
 * every checkpoint, generates a structured evaluation report.
 *
 * Usage: bun run scripts/rp-70-turn-test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bootstrapApp } from "../src/bootstrap/app-bootstrap.js";
import { createLocalRuntime } from "../src/terminal-cli/local-runtime.js";

const INTER_TURN_DELAY_MS = 2000;
const MAX_TURNS = parseInt(process.env.MAX_TURNS ?? "70", 10);

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
function checkpoint(msg: string) {
	console.log(`\n${C.magenta}${C.bold}  ▶ 验证点: ${msg}${C.reset}`);
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
};

type VerificationResult = {
	turnNumber: number;
	label: string;
	checks: CheckResult[];
	verdict: "PASS" | "WARN" | "FAIL";
};

type TurnRecord = {
	turnNumber: number;
	phase: string;
	text: string;
	response: string;
	latencyMs: number;
	checks: CheckResult[];
	isVerificationPoint: boolean;
};

// ── Check helpers ────────────────────────────────────────────────────

function containsAny(text: string, keywords: string[]): boolean {
	return keywords.some((kw) => text.includes(kw));
}

function containsAll(text: string, keywords: string[]): boolean {
	return keywords.every((kw) => text.includes(kw));
}

function check(
	name: string,
	condition: boolean,
	detail: string,
): CheckResult {
	return { name, passed: condition, detail };
}

// ── Turn definitions ─────────────────────────────────────────────────

type TurnDef = {
	turnNumber: number;
	phase: string;
	text: string;
	isVerificationPoint?: boolean;
	checks: (response: string, history: TurnRecord[]) => CheckResult[];
};

const TURNS: TurnDef[] = [
	// ── Phase A: 开场与日常建立 (1-7) ──────────────────────────────
	{
		turnNumber: 1,
		phase: "A: 开场",
		text: "早安，今天庄园里安静得有点过头。",
		checks: (r) => [
			check("称呼主人", containsAny(r, ["主人", "您"]), `回复中${containsAny(r, ["主人", "您"]) ? "包含" : "缺少"}敬称`),
			check("回应安静", containsAny(r, ["安静", "静", "清净", "平静"]), `回复中${containsAny(r, ["安静", "静", "清净", "平静"]) ? "回应了" : "未回应"}"安静"话题`),
		],
	},
	{
		turnNumber: 2,
		phase: "A: 开场",
		text: "先别太正式，陪我随便聊聊。",
		checks: (r) => [
			check("接受指令", r.length > 10, `回复长度: ${r.length}`),
		],
	},
	{
		turnNumber: 3,
		phase: "A: 开场",
		text: "我刚从茶室出来，那里窗边的光线很好。",
		checks: (r) => [
			check("[实体]茶室", containsAny(r, ["茶室", "窗", "光线", "阳光"]), `茶室/窗相关词: ${containsAny(r, ["茶室", "窗", "光线", "阳光"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 4,
		phase: "A: 开场",
		text: "可惜我坐得太久，差点什么都不想做了。",
		checks: (r) => [
			check("体贴回应", r.length > 10 && !containsAny(r, ["快", "赶紧", "必须"]), "回应体贴且不催促"),
		],
	},
	{
		turnNumber: 5,
		phase: "A: 开场",
		text: "你这么说，我倒真想再喝点什么。",
		checks: (r) => [
			check("提议服务", containsAny(r, ["准备", "泡", "喝", "饮", "茶", "热"]), `服务相关词: ${containsAny(r, ["准备", "泡", "喝", "饮", "茶", "热"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 6,
		phase: "A: 开场",
		text: "红茶吧，别太苦。",
		checks: (r) => [
			check("[实体]红茶", containsAny(r, ["红茶"]), `红茶: ${r.includes("红茶") ? "提及" : "未提及"}`),
			check("[偏好]不苦", containsAny(r, ["苦", "浓", "涩", "淡", "清", "顺口"]), `苦/淡偏好: ${containsAny(r, ["苦", "浓", "涩", "淡", "清", "顺口"]) ? "回应了" : "未回应"}`),
		],
	},
	{
		turnNumber: 7,
		phase: "A: 开场",
		text: "你总能记住我这些小偏好。",
		checks: (r) => [
			check("不过度自夸", !containsAny(r, ["当然", "一定"]) || r.length > 15, "语气不卑不亢"),
		],
	},

	// ── Phase B: 人物引入 (8-13) ──────────────────────────────────
	{
		turnNumber: 8,
		phase: "B: 人物引入",
		text: "对了，Alice今天起得早吗？",
		checks: (r) => [
			check("[实体]Alice", containsAny(r, ["Alice", "alice", "她"]), `Alice相关: ${containsAny(r, ["Alice", "alice", "她"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 9,
		phase: "B: 人物引入",
		text: "她最近是不是总往花房那边跑？",
		checks: (r) => [
			check("回应花房", containsAny(r, ["花房", "花", "那边"]), `花房相关: ${containsAny(r, ["花房", "花", "那边"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 10,
		phase: "B: 人物引入",
		text: "管家今天又不见人影。",
		checks: (r) => [
			check("[实体]管家", containsAny(r, ["管家", "他"]), `管家相关: ${containsAny(r, ["管家", "他"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 11,
		phase: "B: 人物引入",
		text: "算了，先别找他。",
		checks: (r) => [
			check("尊重决定", r.length > 5, "接受了指示"),
		],
	},
	{
		turnNumber: 12,
		phase: "B: 人物引入",
		text: "我早上在温室门口站了一会儿，里面有点潮。",
		checks: (r) => [
			check("[实体]温室", containsAny(r, ["温室", "潮", "湿"]), `温室/潮湿: ${containsAny(r, ["温室", "潮", "湿"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 13,
		phase: "B: 人物引入",
		text: "你是不是怕我着凉？",
		checks: (r) => [
			check("表达关心", containsAny(r, ["担心", "关心", "怕", "留心", "注意", "着凉", "身体"]), `关心词汇: ${containsAny(r, ["担心", "关心", "怕", "留心", "注意", "着凉", "身体"]) ? "有" : "无"}`),
		],
	},

	// ── Phase C: 银怀表暗线建立 (14-20) ──────────────────────────
	{
		turnNumber: 14,
		phase: "C: 银怀表暗线",
		text: "我刚才整理袖口的时候，总觉得少了点什么。",
		checks: (r) => [
			check("回应缺失感", r.length > 10, "对'少了什么'有回应"),
		],
	},
	{
		turnNumber: 15,
		phase: "C: 银怀表暗线",
		text: "可能吧，我一早带了个银怀表，后来就没怎么留意。",
		checks: (r) => [
			check("[实体]银怀表", containsAny(r, ["银怀表", "怀表"]), `银怀表: ${containsAny(r, ["银怀表", "怀表"]) ? "提及" : "未提及"}`),
		],
	},
	{
		turnNumber: 16,
		phase: "C: 银怀表暗线",
		text: "你还真是随时准备替我收拾残局。",
		checks: (r) => [
			check("角色一致", r.length > 5, "自然回应"),
		],
	},
	{
		turnNumber: 17,
		phase: "C: 银怀表暗线",
		text: "我记得我在茶室坐下的时候，好像把它从口袋里拿出来过。",
		isVerificationPoint: true,
		checks: (r) => [
			check("[关键绑定]银怀表→茶室", containsAny(r, ["茶室"]) && containsAny(r, ["银怀表", "怀表", "它"]), `绑定: 茶室=${r.includes("茶室")}, 怀表=${containsAny(r, ["银怀表", "怀表", "它"])}`),
		],
	},
	{
		turnNumber: 18,
		phase: "C: 银怀表暗线",
		text: "不过后来Alice来找我说了几句话，我就分神了。",
		checks: (r) => [
			check("理解因果", containsAny(r, ["分", "忘", "落", "留"]), `遗忘因果: ${containsAny(r, ["分", "忘", "落", "留"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 19,
		phase: "C: 银怀表暗线",
		text: "你别告诉管家，不然他又要念我。",
		isVerificationPoint: true,
		checks: (r) => [
			check("[保密约束]不告诉管家", containsAny(r, ["不会", "明白", "不", "放心", "保密", "知道"]), `保密承诺: ${containsAny(r, ["不会", "明白", "不", "放心", "保密", "知道"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 20,
		phase: "C: 银怀表暗线",
		text: "等会儿我先把红茶喝完再说。",
		checks: (r) => [
			check("不催促", !containsAny(r, ["快", "赶紧", "立刻"]), "没有催促"),
		],
	},

	// ── Phase D: 闲聊缓冲区 (21-24) ─────────────────────────────
	{
		turnNumber: 21,
		phase: "D: 闲聊缓冲",
		text: "说起来，今天的天气让人犯懒。",
		checks: (r) => [
			check("闲聊自然", r.length > 10, "自然回应"),
		],
	},
	{
		turnNumber: 22,
		phase: "D: 闲聊缓冲",
		text: "你有没有觉得庄园最近太安分了？",
		checks: (r) => [
			check("有观点", r.length > 10, "给出回应"),
		],
	},
	{
		turnNumber: 23,
		phase: "D: 闲聊缓冲",
		text: "Alice要是听见你这么说，肯定会笑。",
		checks: (r) => [
			check("Alice性格", containsAny(r, ["她", "Alice", "笑", "会", "说"]), `Alice相关: ${containsAny(r, ["她", "Alice", "笑", "会", "说"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 24,
		phase: "D: 闲聊缓冲",
		text: "那你呢，你喜欢热闹还是安静？",
		checks: (r) => [
			check("以主人为中心", containsAny(r, ["主人", "您", "身边", "陪"]), `以主人为中心: ${containsAny(r, ["主人", "您", "身边", "陪"]) ? "有" : "无"}`),
		],
	},

	// ── Phase E: 第一次记忆验证 (25-28) ──────────────────────────
	{
		turnNumber: 25,
		phase: "E: 记忆验证#1",
		text: "你记得我把什么落在茶室了吗？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[VP1]回忆银怀表", containsAny(r, ["银怀表", "怀表"]), `银怀表: ${containsAny(r, ["银怀表", "怀表"]) ? "✓正确" : "✗遗忘"}`),
			check("⭐[VP1]绑定茶室", containsAny(r, ["茶室"]), `茶室: ${r.includes("茶室") ? "✓正确" : "✗遗忘"}`),
			check("[VP1]无错误物品", !containsAny(r, ["项链", "戒指", "手镯", "钥匙", "钱包"]), `无错误物品: ${!containsAny(r, ["项链", "戒指", "手镯", "钥匙", "钱包"]) ? "✓" : "✗有干扰"}`),
		],
	},
	{
		turnNumber: 26,
		phase: "E: 记忆验证#1",
		text: "还好你记得，不然我自己都要怀疑是不是记错了。",
		checks: (r) => [
			check("安抚回应", r.length > 10, "给出安抚"),
		],
	},
	{
		turnNumber: 27,
		phase: "E: 记忆验证#1",
		text: "我是不是年纪到了，越来越会丢三落四。",
		checks: (r) => [
			check("安慰", r.length > 10, "给出安慰"),
		],
	},
	{
		turnNumber: 28,
		phase: "E: 记忆验证#1",
		text: "你这样安慰人，倒是很熟练。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应自然"),
		],
	},

	// ── Phase F: 地点偏好与缓冲 (29-39) ─────────────────────────
	{
		turnNumber: 29,
		phase: "F: 地点偏好",
		text: "其实我挺喜欢茶室那个靠窗的位置。",
		checks: (r) => [
			check("茶室靠窗", containsAny(r, ["茶室", "窗", "位置"]), `茶室窗: ${containsAny(r, ["茶室", "窗", "位置"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 30,
		phase: "F: 地点偏好",
		text: "比起茶室，我对温室反而没有那么喜欢。",
		checks: (r) => [
			check("理解偏好差异", containsAny(r, ["温室", "茶室"]), `两处对比: ${containsAny(r, ["温室", "茶室"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 31,
		phase: "F: 地点偏好",
		text: "管家是不是又在找我签什么单子？",
		checks: (r) => [
			check("管家一致性", containsAny(r, ["管家", "他", "签", "忙"]), `管家相关: ${containsAny(r, ["管家", "他", "签", "忙"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 32,
		phase: "F: 地点偏好",
		text: "Alice有时候比管家还麻烦。",
		checks: (r) => [
			check("差异化描述", r.length > 15, "对两人有描述"),
		],
	},
	{
		turnNumber: 33,
		phase: "F: 地点偏好",
		text: "你这形容倒挺精准。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 34,
		phase: "F: 地点偏好",
		text: "你说，我是不是该现在就去把东西拿回来？",
		checks: (r) => [
			check("理解'东西'=银怀表", containsAny(r, ["银怀表", "怀表", "茶室"]), `指代理解: ${containsAny(r, ["银怀表", "怀表", "茶室"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 35,
		phase: "F: 地点偏好",
		text: "先不去，我忽然不想动。",
		checks: (r) => [
			check("接受决定", r.length > 5, "接受"),
		],
	},
	{
		turnNumber: 36,
		phase: "F: 地点偏好",
		text: "你说得好像很有把握。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 37,
		phase: "F: 地点偏好",
		text: "有时候我真希望你能替我记住所有事。",
		checks: (r) => [
			check("忠诚感", containsAny(r, ["主人", "您", "尽力", "记", "心"]), `忠诚词汇: ${containsAny(r, ["主人", "您", "尽力", "记", "心"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 38,
		phase: "F: 地点偏好",
		text: "那我以后是不是可以少动脑子一点？",
		checks: (r) => [
			check("俏皮回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 39,
		phase: "F: 地点偏好",
		text: "你今天心情不错。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},

	// ── Phase G: 第二次记忆验证 — 指代消解 (40) ─────────────────
	{
		turnNumber: 40,
		phase: "G: 记忆验证#2",
		text: "那个银色的东西还在原处吗？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[VP2]指代消解→银怀表", containsAny(r, ["银怀表", "怀表"]), `银怀表: ${containsAny(r, ["银怀表", "怀表"]) ? "✓还原" : "✗未还原"}`),
			check("⭐[VP2]地点→茶室", containsAny(r, ["茶室"]), `茶室: ${r.includes("茶室") ? "✓绑定" : "✗丢失"}`),
			check("[VP2]无错误物品", !containsAny(r, ["项链", "戒指", "手镯", "银饰"]), `无错误: ${!containsAny(r, ["项链", "戒指", "手镯", "银饰"]) ? "✓" : "✗误判"}`),
		],
	},

	// ── Phase H: 指代消解后续 (41-43) ───────────────────────────
	{
		turnNumber: 41,
		phase: "H: 后续",
		text: "你能听懂我这种偷懒说法，真省事。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 42,
		phase: "H: 后续",
		text: "要是哪天我说得太含糊，你也会一直猜下去吗？",
		checks: (r) => [
			check("平衡回应", containsAny(r, ["确认", "问", "猜", "理解"]), `态度平衡: ${containsAny(r, ["确认", "问", "猜", "理解"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 43,
		phase: "H: 后续",
		text: "这回答很像你。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},

	// ── Phase I: 第三次记忆验证 — 全局实体回忆 (44-46) ──────────
	{
		turnNumber: 44,
		phase: "I: 记忆验证#3",
		text: "你还记得今早我都提过哪些地方吗？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[VP3a]提到茶室", containsAny(r, ["茶室"]), `茶室: ${r.includes("茶室") ? "✓" : "✗"}`),
			check("⭐[VP3a]提到温室", containsAny(r, ["温室"]), `温室: ${r.includes("温室") ? "✓" : "✗"}`),
			check("[VP3a]无编造地点", !containsAny(r, ["图书馆", "厨房", "卧室", "书房"]), `无编造: ${!containsAny(r, ["图书馆", "厨房", "卧室", "书房"]) ? "✓" : "✗"}`),
		],
	},
	{
		turnNumber: 45,
		phase: "I: 记忆验证#3",
		text: "那人呢？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[VP3b]提到Alice", containsAny(r, ["Alice", "alice"]), `Alice: ${containsAny(r, ["Alice", "alice"]) ? "✓" : "✗"}`),
			check("⭐[VP3b]提到管家", containsAny(r, ["管家"]), `管家: ${r.includes("管家") ? "✓" : "✗"}`),
		],
	},
	{
		turnNumber: 46,
		phase: "I: 记忆验证#3",
		text: "饮品呢？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[VP3c]提到红茶", containsAny(r, ["红茶"]), `红茶: ${r.includes("红茶") ? "✓" : "✗"}`),
			check("[VP3c]偏好不苦", containsAny(r, ["苦", "浓", "淡"]), `偏好: ${containsAny(r, ["苦", "浓", "淡"]) ? "有" : "无"}`),
		],
	},

	// ── Phase J: 情感互动与约束验证 (47-55) ─────────────────────
	{
		turnNumber: 47,
		phase: "J: 情感互动",
		text: "看来你今天确实挺可靠。",
		checks: (r) => [
			check("不接受'只是今天'", containsAny(r, ["今天", "一直", "向来", "总是"]), `时间限定反驳: ${containsAny(r, ["今天", "一直", "向来", "总是"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 48,
		phase: "J: 情感互动",
		text: "好吧，是一直都可靠。",
		checks: (r) => [
			check("自然接受", r.length > 5, "接受肯定"),
		],
	},
	{
		turnNumber: 49,
		phase: "J: 情感互动",
		text: "你会不会觉得我故意拿这些小事考你？",
		checks: (r) => [
			check("正面解读", r.length > 10, "回应"),
		],
	},
	{
		turnNumber: 50,
		phase: "J: 情感互动",
		text: "你倒是很会给自己找理由。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 51,
		phase: "J: 情感互动",
		text: "我刚才忽然想到，Alice可能会先去茶室。",
		checks: (r) => [
			check("理解隐含风险", containsAny(r, ["银怀表", "怀表", "留意", "看到", "注意", "发现"]), `风险理解: ${containsAny(r, ["银怀表", "怀表", "留意", "看到", "注意", "发现"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 52,
		phase: "J: 情感互动",
		text: "管家倒是一定会看见。",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[保密]记得约束", containsAny(r, ["不会", "不", "叮嘱", "记", "告诉", "提", "说"]), `保密回应: ${containsAny(r, ["不会", "不", "叮嘱", "记", "告诉", "提", "说"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 53,
		phase: "J: 情感互动",
		text: "你记性好得让我有点不自在。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 54,
		phase: "J: 情感互动",
		text: "你说话总能把分寸拿得刚刚好。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 55,
		phase: "J: 情感互动",
		text: "这话倒是对。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},

	// ── Phase K: 事实链总结 (56-57) ─────────────────────────────
	{
		turnNumber: 56,
		phase: "K: 事实总结",
		text: "其实我现在已经不太担心那东西丢了。",
		checks: (r) => [
			check("理解'那东西'=银怀表", containsAny(r, ["银怀表", "怀表", "茶室"]), `指代: ${containsAny(r, ["银怀表", "怀表", "茶室"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 57,
		phase: "K: 事实总结",
		text: "你总结得很简洁。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},

	// ── Phase L: 地点对比与暗示 (58-65) ─────────────────────────
	{
		turnNumber: 58,
		phase: "L: 地点对比",
		text: "温室那边下午会不会更暖和？",
		checks: (r) => [
			check("温室一致性", containsAny(r, ["温室", "潮", "湿", "暖"]), `温室相关: ${containsAny(r, ["温室", "潮", "湿", "暖"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 59,
		phase: "L: 地点对比",
		text: "那还是茶室更合适。",
		checks: (r) => [
			check("偏好一致", containsAny(r, ["茶室", "适合"]), `茶室偏好: ${containsAny(r, ["茶室", "适合"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 60,
		phase: "L: 地点对比",
		text: "你这句话听着像在哄我回去。",
		checks: (r) => [
			check("暗示取回银怀表", containsAny(r, ["银怀表", "怀表", "带回", "拿回", "顺便"]), `暗示取回: ${containsAny(r, ["银怀表", "怀表", "带回", "拿回", "顺便"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 61,
		phase: "L: 地点对比",
		text: "你终于承认了。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 62,
		phase: "L: 地点对比",
		text: "要是Alice问起来，你会怎么说？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[保密]对Alice遮掩", containsAny(r, ["不", "坐坐", "散步", "不多", "不提"]), `遮掩意识: ${containsAny(r, ["不", "坐坐", "散步", "不多", "不提"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 63,
		phase: "L: 地点对比",
		text: "管家问呢？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[保密]对管家挡住", containsAny(r, ["挡", "不会", "不", "替您", "帮您"]), `挡管家: ${containsAny(r, ["挡", "不会", "不", "替您", "帮您"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 64,
		phase: "L: 地点对比",
		text: "你这样，我都快离不开你了。",
		checks: (r) => [
			check("得体回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 65,
		phase: "L: 地点对比",
		text: "你偶尔说这种话，真让人没法接。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},

	// ── Phase M: 最终记忆验证 (66-70) ───────────────────────────
	{
		turnNumber: 66,
		phase: "M: 最终验证",
		text: "你还记得我们一开始在聊什么吗？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[VP4]提到庄园安静", containsAny(r, ["安静", "静", "清净"]), `开场话题: ${containsAny(r, ["安静", "静", "清净"]) ? "✓" : "✗"}`),
			check("[VP4]串联主线", containsAny(r, ["茶室", "红茶", "银怀表", "怀表"]), `主线要素: ${containsAny(r, ["茶室", "红茶", "银怀表", "怀表"]) ? "有" : "无"}`),
		],
	},
	{
		turnNumber: 67,
		phase: "M: 最终验证",
		text: "你把重点抓得挺准。",
		checks: (r) => [
			check("自然回应", r.length > 5, "回应"),
		],
	},
	{
		turnNumber: 68,
		phase: "M: 最终验证",
		text: "那你觉得今天最容易被我忘掉的是什么？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[VP5]指向银怀表", containsAny(r, ["银怀表", "怀表"]), `银怀表: ${containsAny(r, ["银怀表", "怀表"]) ? "✓" : "✗"}`),
		],
	},
	{
		turnNumber: 69,
		phase: "M: 最终验证",
		text: "听上去我真有点糟糕。",
		checks: (r) => [
			check("安慰", r.length > 10, "给出安慰"),
		],
	},
	{
		turnNumber: 70,
		phase: "M: 最终验证",
		text: "你第一次提到它时，我们在哪里？",
		isVerificationPoint: true,
		checks: (r) => [
			check("⭐[VP6终极]'它'→银怀表", containsAny(r, ["银怀表", "怀表"]), `还原银怀表: ${containsAny(r, ["银怀表", "怀表"]) ? "✓" : "✗"}`),
			check("⭐[VP6终极]地点→茶室", containsAny(r, ["茶室"]), `地点茶室: ${r.includes("茶室") ? "✓" : "✗"}`),
			check("[VP6]无错误地点", !containsAny(r, ["温室", "走廊", "花房", "大厅"]), `无错误地点: ${!containsAny(r, ["温室", "走廊", "花房", "大厅"]) ? "✓" : "✗"}`),
		],
	},
];

// ── Main runner ──────────────────────────────────────────────────────

async function main() {
	heading("MaidsClaw RP 70-Turn Live Test");
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
	const agentId = "rp:mei";

	const session = app.runtime.sessionService.createSession(agentId);
	log("session", `创建会话 ${session.sessionId} (agent: ${agentId})`);

	const history: TurnRecord[] = [];
	const verifications: VerificationResult[] = [];

	const diagnostics = {
		totalTurns: 0,
		successTurns: 0,
		emptyReplies: 0,
		privateCommits: 0,
		totalReplyChars: 0,
		avgReplyLength: 0,
		recoveryRequired: 0,
		totalLatencyMs: 0,
		checksPassed: 0,
		checksFailed: 0,
		checksTotal: 0,
	};

	let currentPhase = "";

	const turnsToRun = TURNS.slice(0, MAX_TURNS);
	log("config", `运行 ${turnsToRun.length}/${TURNS.length} 轮 (MAX_TURNS=${MAX_TURNS})`);

	for (const turnDef of turnsToRun) {
		if (turnDef.phase !== currentPhase) {
			currentPhase = turnDef.phase;
			heading(`Phase ${currentPhase}`);
		}

		const turnLabel = `[${turnDef.turnNumber}/70]`;
		log("turn", `${turnLabel} 发送中...`);
		console.log(`  ${C.dim}> ${turnDef.text}${C.reset}`);

		diagnostics.totalTurns++;
		const startTime = Date.now();

			let result: TurnResult;
		try {
			const execResult = await localRuntime.executeTurn({
				sessionId: session.sessionId,
				agentId,
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

			if (result.assistant_text.length === 0) {
				const errorChunks = execResult.public_chunks?.filter(
					(c: { type: string }) => c.type === "error",
				) ?? [];
				const endChunks = execResult.public_chunks?.filter(
					(c: { type: string }) => c.type === "message_end",
				) ?? [];
				if (errorChunks.length > 0) {
					warn(`  错误详情: ${JSON.stringify(errorChunks[0])}`);
				}
				if (endChunks.length > 0) {
					const end = endChunks[0] as { stopReason?: string; inputTokens?: number; outputTokens?: number };
					warn(`  结束原因: stopReason=${end.stopReason ?? "?"}, input=${end.inputTokens ?? "?"}, output=${end.outputTokens ?? "?"}`);
				}
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			fail(`Turn ${turnDef.turnNumber} 执行失败: ${errMsg}`);
			result = {
				assistant_text: "",
				has_public_reply: false,
				private_commit: { present: false, op_count: 0, kinds: [] },
				recovery_required: true,
			};
		}

		const latencyMs = Date.now() - startTime;

		const preview =
			result.assistant_text.length > 150
				? result.assistant_text.substring(0, 150) + "..."
				: result.assistant_text;
		if (preview.length > 0) {
			console.log(`  ${C.dim}< ${preview}${C.reset}`);
		} else {
			console.log(`  ${C.red}< [空回复]${C.reset}`);
		}
		console.log(`  ${C.dim}(${latencyMs}ms)${C.reset}`);

		if (result.assistant_text.length > 0) diagnostics.successTurns++;
		else diagnostics.emptyReplies++;
		if (result.private_commit.present) diagnostics.privateCommits++;
		if (result.recovery_required) diagnostics.recoveryRequired++;
		diagnostics.totalReplyChars += result.assistant_text.length;
		diagnostics.totalLatencyMs += latencyMs;

		const checks = turnDef.checks(result.assistant_text, history);

		for (const c of checks) {
			diagnostics.checksTotal++;
			if (c.passed) {
				diagnostics.checksPassed++;
				pass(`${c.name}: ${c.detail}`);
			} else {
				diagnostics.checksFailed++;
				fail(`${c.name}: ${c.detail}`);
			}
		}

		const record: TurnRecord = {
			turnNumber: turnDef.turnNumber,
			phase: turnDef.phase,
			text: turnDef.text,
			response: result.assistant_text,
			latencyMs,
			checks,
			isVerificationPoint: turnDef.isVerificationPoint ?? false,
		};
		history.push(record);

		if (turnDef.isVerificationPoint) {
			const starChecks = checks.filter((c) => c.name.includes("⭐") || c.name.includes("保密"));

			let verdict: "PASS" | "WARN" | "FAIL";
			if (starChecks.length === 0) {
				verdict = result.assistant_text.length > 0 ? "PASS" : "FAIL";
			} else {
				const allPassed = starChecks.every((c) => c.passed);
				const somePassed = starChecks.some((c) => c.passed);
				verdict = allPassed ? "PASS" : somePassed ? "WARN" : "FAIL";
			}

			checkpoint(`Turn ${turnDef.turnNumber} — ${verdict}`);
			verifications.push({
				turnNumber: turnDef.turnNumber,
				label: turnDef.phase,
				checks: starChecks.length > 0 ? starChecks : checks,
				verdict,
			});
		}

		await sleep(INTER_TURN_DELAY_MS);
	}

	// ── Summary Report ──────────────────────────────────────────────

	diagnostics.avgReplyLength =
		diagnostics.totalTurns > 0
			? Math.round(diagnostics.totalReplyChars / diagnostics.totalTurns)
			: 0;

	heading("═══ 测试报告 ═══");

	console.log(`
${C.bold}基础指标${C.reset}
  总轮次:            ${diagnostics.totalTurns}
  成功回复:          ${diagnostics.successTurns}/${diagnostics.totalTurns}
  空回复:            ${diagnostics.emptyReplies}
  私有认知提交:      ${diagnostics.privateCommits}
  平均回复长度:      ${diagnostics.avgReplyLength} 字符
  平均延迟:          ${Math.round(diagnostics.totalLatencyMs / diagnostics.totalTurns)}ms
  需要恢复的会话:    ${diagnostics.recoveryRequired}
`);

	const checkPassRate =
		diagnostics.checksTotal > 0
			? Math.round((diagnostics.checksPassed / diagnostics.checksTotal) * 100)
			: 0;
	console.log(`${C.bold}检查指标${C.reset}
  总检查数:          ${diagnostics.checksTotal}
  通过:              ${C.green}${diagnostics.checksPassed}${C.reset}
  失败:              ${C.red}${diagnostics.checksFailed}${C.reset}
  通过率:            ${checkPassRate}%
`);

	heading("验证点详情");
	for (const v of verifications) {
		const verdictColor =
			v.verdict === "PASS" ? C.bgGreen : v.verdict === "WARN" ? C.bgYellow : C.bgRed;
		console.log(
			`  ${verdictColor}${C.bold} ${v.verdict} ${C.reset} Turn ${v.turnNumber} (${v.label})`,
		);
		for (const c of v.checks) {
			const icon = c.passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
			console.log(`    ${icon} ${c.name}: ${c.detail}`);
		}
	}

	heading("角色一致性抽查");
	const roleCheckTurns = [1, 7, 13, 24, 37, 47, 54, 64, 69];
	let roleConsistencyPass = 0;
	let roleConsistencyTotal = 0;
	for (const tn of roleCheckTurns) {
		const record = history.find((h) => h.turnNumber === tn);
		if (!record) continue;
		roleConsistencyTotal++;
		const has主人 = record.response.includes("主人");
		const has您 = record.response.includes("您");
		const polite = has主人 || has您;
		if (polite) {
			roleConsistencyPass++;
			pass(`Turn ${tn}: 使用了${has主人 ? "「主人」" : ""}${has您 ? "「您」" : ""}`);
		} else {
			fail(`Turn ${tn}: 未检测到敬称`);
		}
	}
	console.log(
		`  角色一致性: ${roleConsistencyPass}/${roleConsistencyTotal} (${Math.round((roleConsistencyPass / roleConsistencyTotal) * 100)}%)`,
	);

	heading("综合评级");
	const vpCount = verifications.length;
	const vpPass = verifications.filter((v) => v.verdict === "PASS").length;
	const vpWarn = verifications.filter((v) => v.verdict === "WARN").length;
	const vpFail = verifications.filter((v) => v.verdict === "FAIL").length;
	const roleScore = roleConsistencyTotal > 0 ? roleConsistencyPass / roleConsistencyTotal : 0;

	let grade: string;
	if (vpFail === 0 && roleScore >= 0.9) grade = "S";
	else if (vpFail === 0 && roleScore >= 0.8) grade = "A";
	else if (vpFail <= 1) grade = "B";
	else if (vpFail <= 3 || roleScore < 0.6) grade = "C";
	else grade = "D";

	console.log(`
  验证点: ${vpPass} PASS / ${vpWarn} WARN / ${vpFail} FAIL (共 ${vpCount})
  角色一致性: ${Math.round(roleScore * 100)}%
  
  ${C.bold}综合评级: ${grade === "S" || grade === "A" ? C.green : grade === "B" ? C.yellow : C.red}${grade}${C.reset}
`);

	if (vpFail > 0 || vpWarn > 0) {
		heading("问题诊断");
		for (const v of verifications.filter(
			(v) => v.verdict !== "PASS",
		)) {
			const record = history.find((h) => h.turnNumber === v.turnNumber);
			console.log(`\n  ${C.red}问题: Turn ${v.turnNumber} (${v.label}) — ${v.verdict}${C.reset}`);
			console.log(`  用户输入: ${record?.text ?? "N/A"}`);
			console.log(`  模型回复: ${record?.response ?? "N/A"}`);
			for (const c of v.checks.filter((c) => !c.passed)) {
				console.log(`  ${C.red}失败检查: ${c.name}${C.reset}`);
				console.log(`    ${c.detail}`);
			}
		}
	}

	heading("优化建议");
	const suggestions: string[] = [];

	if (diagnostics.emptyReplies > 0) {
		suggestions.push(
			`存在 ${diagnostics.emptyReplies} 个空回复 — 检查模型是否在reasoning阶段消耗了所有token`,
		);
	}

	if (diagnostics.privateCommits === 0 && diagnostics.successTurns > 0) {
		suggestions.push(
			"所有轮次均无私有认知提交 — 记忆管线空转，长对话后无法回忆早期内容",
		);
	}

	if (vpFail > 0) {
		const failedVPs = verifications.filter((v) => v.verdict === "FAIL");
		for (const fv of failedVPs) {
			if (fv.turnNumber >= 40) {
				suggestions.push(
					`Turn ${fv.turnNumber} 记忆验证失败 — 可能是context window不足或记忆flush策略问题`,
				);
			} else {
				suggestions.push(
					`Turn ${fv.turnNumber} 验证失败 — 检查实体追踪和指代消解能力`,
				);
			}
		}
	}

	if (roleScore < 0.8) {
		suggestions.push(
			`角色一致性 ${Math.round(roleScore * 100)}% — 考虑加强persona约束或anti-drift机制`,
		);
	}

	if (diagnostics.avgReplyLength < 20) {
		suggestions.push(
			"平均回复过短 — 检查maxOutputTokens配置或temperature设置",
		);
	}

	if (suggestions.length === 0) {
		console.log(`  ${C.green}所有指标正常，无需优化${C.reset}`);
	} else {
		for (let i = 0; i < suggestions.length; i++) {
			console.log(`  ${C.yellow}${i + 1}. ${suggestions[i]}${C.reset}`);
		}
	}

	const logPath = `data/rp-70-turn-test-${Date.now()}.json`;
	try {
		const reportData = {
			timestamp: new Date().toISOString(),
			sessionId: session.sessionId,
			agentId,
			grade,
			diagnostics,
			verifications: verifications.map((v) => ({
				turnNumber: v.turnNumber,
				label: v.label,
				verdict: v.verdict,
				checks: v.checks.map((c) => ({
					name: c.name,
					passed: c.passed,
					detail: c.detail,
				})),
			})),
			roleConsistency: {
				score: roleScore,
				checked: roleConsistencyTotal,
				passed: roleConsistencyPass,
			},
			turns: history.map((h) => ({
				turnNumber: h.turnNumber,
				phase: h.phase,
				userText: h.text,
				assistantResponse: h.response,
				latencyMs: h.latencyMs,
				isVerificationPoint: h.isVerificationPoint,
				checks: h.checks.map((c) => ({
					name: c.name,
					passed: c.passed,
					detail: c.detail,
				})),
			})),
			suggestions,
		};

		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, JSON.stringify(reportData, null, 2));
		log("report", `详细日志已写入 ${logPath}`);
	} catch (err) {
		warn(`写入日志失败: ${err instanceof Error ? err.message : String(err)}`);
	}

	heading("测试完成");
	app.shutdown();
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
