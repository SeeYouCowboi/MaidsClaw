#!/usr/bin/env bun
/**
 * Minimal diagnostic: run ONE RP turn and dump every chunk + result.
 */
import { bootstrapApp } from "../src/bootstrap/app-bootstrap.js";
import { createLocalRuntime } from "../src/cli/local-runtime.js";

const AGENT_ID = process.env.AGENT_ID ?? "rp:eveline";

async function main() {
	console.log("[debug] Bootstrapping...");
	const app = bootstrapApp({
		cwd: process.cwd(),
		enableGateway: false,
		requireAllProviders: false,
	});
	console.log("[debug] Bootstrap OK");

	const localRuntime = createLocalRuntime(app.runtime);
	const session = app.runtime.sessionService.createSession(AGENT_ID);
	console.log(`[debug] Session: ${session.sessionId}`);

	const profile = app.runtime.agentRegistry.get(AGENT_ID);
	console.log(`[debug] Agent: ${AGENT_ID}, modelId: ${profile?.modelId}`);

	console.log("[debug] Sending turn...");
	const t0 = Date.now();
	try {
		const result = await localRuntime.executeTurn({
			sessionId: session.sessionId,
			agentId: AGENT_ID,
			text: "你回来了，刚才管家是不是来找过我？",
			saveTrace: true,
		});
		const elapsed = Date.now() - t0;

		console.log(`\n[debug] === RESULT (${elapsed}ms) ===`);
		console.log(`  assistant_text: "${result.assistant_text.substring(0, 300)}${result.assistant_text.length > 300 ? '...' : ''}"`);
		console.log(`  assistant_text length: ${result.assistant_text.length}`);
		console.log(`  has_public_reply: ${result.has_public_reply}`);
		console.log(`  private_commit: ${JSON.stringify(result.private_commit)}`);
		console.log(`  recovery_required: ${result.recovery_required}`);
		console.log(`  settlement_id: ${result.settlement_id}`);
		console.log(`  public_chunks count: ${result.public_chunks.length}`);
		console.log(`  tool_events count: ${result.tool_events.length}`);

		// Dump all chunks
		console.log(`\n[debug] === ALL PUBLIC CHUNKS ===`);
		for (const chunk of result.public_chunks) {
			const preview = JSON.stringify(chunk).substring(0, 300);
			console.log(`  ${preview}`);
		}

		// Look for error chunks specifically
		const errorChunks = result.public_chunks.filter(c => c.type === "error");
		if (errorChunks.length > 0) {
			console.log(`\n[debug] === ERROR CHUNKS ===`);
			for (const ec of errorChunks) {
				console.log(`  code: ${ec.code}`);
				console.log(`  message: ${ec.message}`);
			}
		}
	} catch (err) {
		console.error("[debug] executeTurn threw:", err);
	}

	app.shutdown();
}

main().catch(console.error);
