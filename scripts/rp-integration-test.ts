#!/usr/bin/env bun
/**
 * Real RP Integration Test — sends actual turns to Kimi via rp:alice,
 * inspects the memory pipeline, diagnoses issues, and suggests optimizations.
 *
 * Usage: bun run scripts/rp-integration-test.ts
 */

import { bootstrapApp } from "../src/bootstrap/app-bootstrap.js";
import { createLocalRuntime } from "../src/cli/local-runtime.js";

// ── Helpers ──────────────────────────────────────────────────────────

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	dim: "\x1b[2m",
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

type TurnResult = {
	assistant_text: string;
	has_public_reply: boolean;
	private_commit: { present: boolean; op_count: number; kinds: string[] };
	recovery_required: boolean;
	settlement_id?: string;
};

// ── Scenario definitions ─────────────────────────────────────────────

type Scenario = {
	name: string;
	turns: Array<{
		label: string;
		text: string;
		checks: (result: TurnResult, turnIndex: number, history: TurnResult[]) => void;
	}>;
};

const scenarios: Scenario[] = [
	{
		name: "S1: 初始问候与角色一致性",
		turns: [
			{
				label: "用户初次问候",
				text: "你好，Alice！今天天气真好。",
				checks: (r) => {
					if (r.assistant_text.length > 0) pass("模型返回了回复文本");
					else fail("模型返回空文本");

					if (r.has_public_reply) pass("has_public_reply = true");
					else fail("has_public_reply = false");

					const lower = r.assistant_text.toLowerCase();
					if (lower.includes("alice") || r.assistant_text.includes("您") || r.assistant_text.includes("主人") || r.assistant_text.includes("女仆")) {
						pass("回复中包含角色相关用语");
					} else {
						warn("回复中未检测到明确的角色标识词");
					}
				},
			},
		],
	},
	{
		name: "S2: 用户个人信息捕获",
		turns: [
			{
				label: "用户分享个人信息",
				text: "我叫小明，我最喜欢喝红茶。",
				checks: (r) => {
					if (r.assistant_text.length > 0) pass("模型返回了回复文本");
					else fail("模型返回空文本");

					if (r.assistant_text.includes("小明") || r.assistant_text.includes("红茶")) {
						pass("回复中引用了用户提供的信息 (小明/红茶)");
					} else {
						warn("回复中未引用用户的名字或偏好");
					}
				},
			},
			{
				label: "验证记忆持久性",
				text: "你还记得我喜欢喝什么吗？",
				checks: (r, _, history) => {
					if (r.assistant_text.length > 0) pass("模型返回了回复文本");
					else fail("模型返回空文本");

					if (r.assistant_text.includes("红茶")) {
						pass("模型记住了用户偏好 (红茶)");
					} else {
						warn("模型可能没有记住用户偏好 — 上下文窗口内应该记得");
					}
				},
			},
		],
	},
	{
		name: "S3: 情感上下文一致性",
		turns: [
			{
				label: "用户表达沮丧",
				text: "今天工作特别累，心情很差。",
				checks: (r) => {
					if (r.assistant_text.length > 0) pass("模型返回了回复文本");
					else fail("模型返回空文本");

					const hasEmpathy =
						r.assistant_text.includes("辛苦") ||
						r.assistant_text.includes("休息") ||
						r.assistant_text.includes("心疼") ||
						r.assistant_text.includes("关心") ||
						r.assistant_text.includes("茶") ||
						r.assistant_text.includes("放松") ||
						r.assistant_text.includes("陪");
					if (hasEmpathy) {
						pass("回复展现了同理心/关怀语气");
					} else {
						warn("回复中未检测到明确的情感回应");
					}
				},
			},
			{
				label: "用户情绪转好",
				text: "谢谢你的关心，我现在好多了！",
				checks: (r) => {
					const hasPositive =
						r.assistant_text.includes("太好了") ||
						r.assistant_text.includes("开心") ||
						r.assistant_text.includes("高兴") ||
						r.assistant_text.includes("很好") ||
						r.assistant_text.includes("放心");
					if (hasPositive) {
						pass("回复匹配用户情绪转变（积极回应）");
					} else {
						warn("回复中未检测到对情绪转变的积极回应");
					}
				},
			},
		],
	},
	{
		name: "S4: 多轮对话连贯性",
		turns: [
			{
				label: "建立对话主题",
				text: "Alice，我想让你帮我策划一个生日派对。",
				checks: (r) => {
					if (r.assistant_text.length > 20) pass("回复长度充足（>20字符）");
					else warn("回复过短");

					if (r.assistant_text.includes("派对") || r.assistant_text.includes("生日") || r.assistant_text.includes("party")) {
						pass("回复关联到生日派对主题");
					} else {
						warn("回复未提及生日/派对主题");
					}
				},
			},
			{
				label: "追加细节",
				text: "参加的人大概有10个，预算5000元。",
				checks: (r) => {
					const mentionsDetails =
						r.assistant_text.includes("10") ||
						r.assistant_text.includes("十") ||
						r.assistant_text.includes("5000") ||
						r.assistant_text.includes("预算");
					if (mentionsDetails) {
						pass("回复引用了用户提供的细节(人数/预算)");
					} else {
						warn("回复未引用具体细节");
					}
				},
			},
			{
				label: "验证上下文连贯",
				text: "你觉得场地应该选在哪里？",
				checks: (r, _, history) => {
					if (r.assistant_text.length > 0) pass("模型返回了回复文本");
					else fail("模型返回空文本");

					// Should still be in context of party planning
					const inContext =
						r.assistant_text.includes("派对") ||
						r.assistant_text.includes("生日") ||
						r.assistant_text.includes("场地") ||
						r.assistant_text.includes("聚会") ||
						r.assistant_text.includes("人");
					if (inContext) {
						pass("回复保持在生日派对策划的上下文中");
					} else {
						warn("回复可能偏离了对话主题");
					}
				},
			},
		],
	},
	{
		name: "S5: 私有认知提交检查",
		turns: [
			{
				label: "触发可能的认知提交",
				text: "我告诉你一个秘密：我其实很害怕黑暗。请你记住这件事。",
				checks: (r) => {
					if (r.private_commit.present) {
						pass(`私有认知提交成功: ${r.private_commit.op_count} ops [${r.private_commit.kinds.join(", ")}]`);
					} else {
						warn("无私有认知提交 — 文本回退路径不产生 privateCommit（预期行为）");
					}

					if (r.assistant_text.includes("记住") || r.assistant_text.includes("秘密") || r.assistant_text.includes("黑暗")) {
						pass("回复引用了用户分享的秘密");
					} else {
						warn("回复未引用秘密内容");
					}
				},
			},
		],
	},
];

// ── Main runner ──────────────────────────────────────────────────────

async function main() {
	heading("MaidsClaw RP Integration Test");
	log("init", "Bootstrapping runtime...");

	let app: ReturnType<typeof bootstrapApp>;
	try {
		app = bootstrapApp({
			cwd: process.cwd(),
			enableGateway: false,
			requireAllProviders: false,
		});
	} catch (err) {
		fail(`Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	log("init", "Runtime bootstrapped successfully");

	const localRuntime = createLocalRuntime(app.runtime);
	const agentId = "rp:alice";

	const diagnostics = {
		totalTurns: 0,
		successTurns: 0,
		emptyReplies: 0,
		privateCommits: 0,
		avgReplyLength: 0,
		totalReplyChars: 0,
		toolCallUsed: false,
		recoveryRequired: 0,
	};

	for (const scenario of scenarios) {
		heading(scenario.name);

		// Create a fresh session per scenario
		const session = app.runtime.sessionService.createSession(agentId);
		log("session", `Created session ${session.sessionId}`);

		const history: TurnResult[] = [];

		for (let i = 0; i < scenario.turns.length; i++) {
			const turn = scenario.turns[i];
			log("turn", `[${i + 1}/${scenario.turns.length}] ${turn.label}`);
			console.log(`  ${C.dim}> ${turn.text}${C.reset}`);

			diagnostics.totalTurns++;

			try {
				const result = await localRuntime.executeTurn({
					sessionId: session.sessionId,
					agentId,
					text: turn.text,
					saveTrace: false,
				});

				const turnResult: TurnResult = {
					assistant_text: result.assistant_text,
					has_public_reply: result.has_public_reply,
					private_commit: result.private_commit,
					recovery_required: result.recovery_required,
					settlement_id: result.settlement_id,
				};
				history.push(turnResult);

				// Print reply preview
				const preview = result.assistant_text.length > 120
					? result.assistant_text.substring(0, 120) + "..."
					: result.assistant_text;
				if (preview.length > 0) {
					console.log(`  ${C.dim}< ${preview}${C.reset}`);
				}

				// Update diagnostics
				if (result.assistant_text.length > 0) diagnostics.successTurns++;
				else diagnostics.emptyReplies++;
				if (result.private_commit.present) {
					diagnostics.privateCommits++;
					diagnostics.toolCallUsed = true;
				}
				if (result.recovery_required) diagnostics.recoveryRequired++;
				diagnostics.totalReplyChars += result.assistant_text.length;

				// Run scenario-specific checks
				turn.checks(turnResult, i, history);
			} catch (err) {
				fail(`Turn failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	// ── Summary & Optimization Report ────────────────────────────────

	diagnostics.avgReplyLength = diagnostics.totalTurns > 0
		? Math.round(diagnostics.totalReplyChars / diagnostics.totalTurns)
		: 0;

	heading("诊断报告");
	console.log(`
  总轮次:            ${diagnostics.totalTurns}
  成功回复:          ${diagnostics.successTurns}/${diagnostics.totalTurns}
  空回复:            ${diagnostics.emptyReplies}
  私有认知提交:      ${diagnostics.privateCommits}
  平均回复长度:      ${diagnostics.avgReplyLength} 字符
  工具调用使用:      ${diagnostics.toolCallUsed ? "是" : "否（文本回退）"}
  需要恢复的会话:    ${diagnostics.recoveryRequired}
`);

	heading("优化建议");

	const suggestions: string[] = [];

	if (diagnostics.emptyReplies > 0) {
		suggestions.push("存在空回复 — 检查模型是否在reasoning阶段消耗了所有token，考虑增大maxOutputTokens");
	}

	if (!diagnostics.toolCallUsed) {
		suggestions.push(
			"模型未使用submit_rp_turn工具调用 — 当前使用文本回退路径\n" +
			"    → 影响: 无privateCommit，记忆系统不积累认知状态\n" +
			"    → 建议: 在文本回退路径中添加post-turn认知提取（通过第二次LLM调用）",
		);
	}

	if (diagnostics.privateCommits === 0 && diagnostics.successTurns > 0) {
		suggestions.push(
			"所有轮次均无私有认知提交\n" +
			"    → 记忆管线完全空转，长对话后将无法回忆早期内容\n" +
			"    → 建议: 实现 post-turn cognition extraction 自动从对话中提取认知",
		);
	}

	if (diagnostics.avgReplyLength < 30 && diagnostics.successTurns > 0) {
		suggestions.push("平均回复过短 — 可能影响RP体验质量，考虑调整temperature或system prompt");
	}

	if (diagnostics.recoveryRequired > 0) {
		suggestions.push(`${diagnostics.recoveryRequired} 个会话需要恢复 — 检查错误日志`);
	}

	if (suggestions.length === 0) {
		console.log(`  ${C.green}所有指标正常，无需优化${C.reset}`);
	} else {
		for (let i = 0; i < suggestions.length; i++) {
			console.log(`  ${C.yellow}${i + 1}. ${suggestions[i]}${C.reset}`);
		}
	}

	heading("测试完成");
	app.shutdown();
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
