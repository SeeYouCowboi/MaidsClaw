/**
 * End-to-end functional test: Kimi K2.5 via rp:mei agent.
 *
 * Creates a session + sends a turn in a single runtime lifecycle
 * (session service is in-memory, so cross-process lookup won't work).
 */

import { createAppHost } from "../src/app/host/index.js";

async function main() {
	console.log("=== MaidsClaw Functional Test: Kimi K2.5 + rp:mei ===\n");

	console.log("[1/4] Bootstrapping runtime...");
	const host = await createAppHost({
		role: "local",
		requireAllProviders: false,
	});

	if (!host.user) {
		console.error("FAIL: createAppHost did not produce a user facade");
		process.exit(1);
	}

	console.log("[2/4] Creating session for rp:mei...");
	const session = await host.user.session.createSession("rp:mei");
	console.log(`  session_id: ${session.session_id}`);
	console.log(`  created_at: ${new Date(session.created_at).toISOString()}`);

	console.log("[3/4] Sending turn: '你好，梅。今天过得怎么样？'");
	const startTime = Date.now();

	const chunks: string[] = [];
	let turnError: string | undefined;

	for await (const event of host.user.turn.streamTurn({
		sessionId: session.session_id,
		text: "你好，梅。今天过得怎么样？",
		agentId: "rp:mei",
		requestId: crypto.randomUUID(),
	})) {
		if (event.type === "text_delta") {
			chunks.push(event.text);
			process.stdout.write(event.text);
		}
		if (event.type === "error") {
			turnError = event.message;
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	console.log(`\n\n[4/4] Turn completed in ${elapsed}s`);

	if (turnError) {
		console.error(`FAIL: Turn error: ${turnError}`);
		await host.shutdown();
		process.exit(1);
	}

	const fullResponse = chunks.join("");
	console.log(`\n--- Response Summary ---`);
	console.log(`  Length: ${fullResponse.length} chars`);
	console.log(`  Has content: ${fullResponse.length > 0 ? "YES ✓" : "NO ✗"}`);
	console.log(`  Latency: ${elapsed}s`);
	console.log(`  Model: moonshot/kimi-k2.5 (via rp:mei agent)`);

	if (fullResponse.length > 0) {
		console.log("\n=== PASS: Kimi K2.5 functional test succeeded ===");
	} else {
		console.log("\n=== WARN: Empty response (might be silent turn) ===");
	}

	await host.shutdown();
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
