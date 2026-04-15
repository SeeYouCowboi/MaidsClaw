/**
 * Port-in-use detection and interactive kill prompt for startup scripts.
 */

async function execSilent(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	await proc.exited;
	return new Response(proc.stdout).text();
}

export type PortProcess = { pid: number; name: string };

export function isPortInUseError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as NodeJS.ErrnoException).code;
	return (
		code === "EADDRINUSE" ||
		/EADDRINUSE/.test(err.message) ||
		/address already in use/i.test(err.message) ||
		/port.*in use/i.test(err.message)
	);
}

async function findPortProcessWindows(port: number): Promise<PortProcess | null> {
	const output = await execSilent(["netstat", "-ano", "-p", "TCP"]);
	const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");
	for (const line of output.split(/\r?\n/)) {
		const m = re.exec(line);
		if (!m) continue;
		const pid = parseInt(m[1], 10);
		if (Number.isNaN(pid)) continue;
		try {
			const taskOut = await execSilent([
				"tasklist", "/fi", `PID eq ${pid}`, "/fo", "csv", "/nh",
			]);
			const nameMatch = /"([^"]+)"/.exec(taskOut.trim());
			return { pid, name: nameMatch?.[1] ?? "unknown" };
		} catch {
			return { pid, name: "unknown" };
		}
	}
	return null;
}

async function findPortProcessUnix(port: number): Promise<PortProcess | null> {
	try {
		const out = await execSilent(["lsof", "-ti", `tcp:${port}`]);
		const pid = parseInt(out.trim().split("\n")[0], 10);
		if (!Number.isNaN(pid) && pid > 0) {
			const nameOut = await execSilent(["ps", "-p", String(pid), "-o", "comm="]);
			return { pid, name: nameOut.trim() || "unknown" };
		}
	} catch {
		// lsof unavailable, fall through
	}
	return null;
}

export async function findPortProcess(port: number): Promise<PortProcess | null> {
	try {
		return process.platform === "win32"
			? await findPortProcessWindows(port)
			: await findPortProcessUnix(port);
	} catch {
		return null;
	}
}

async function killPortProcess(pid: number): Promise<void> {
	if (process.platform === "win32") {
		await execSilent(["taskkill", "/PID", String(pid), "/F"]);
	} else {
		await execSilent(["kill", "-9", String(pid)]);
	}
}

function readLine(): Promise<string> {
	if (!process.stdin.isTTY) {
		return Promise.resolve("n");
	}
	return new Promise((resolve) => {
		process.stdin.setEncoding("utf8");
		process.stdin.resume();
		process.stdin.once("data", (chunk) => {
			process.stdin.pause();
			resolve(String(chunk).trim());
		});
	});
}

/**
 * Runs `startFn`. If it fails with EADDRINUSE, looks up the occupying process
 * on `port`, prompts the user, kills it if confirmed, and retries once.
 */
export async function startWithPortCheck(
	port: number,
	startFn: () => Promise<void>,
): Promise<void> {
	try {
		await startFn();
	} catch (err) {
		if (!isPortInUseError(err)) throw err;

		const proc = await findPortProcess(port);
		if (!proc) {
			throw new Error(
				`Port ${port} is already in use (could not identify the occupying process).`,
			);
		}

		process.stdout.write(
			`\n[WARN] Port ${port} is already in use by "${proc.name}" (PID: ${proc.pid}).\n` +
			`Kill it and retry? [y/N] `,
		);

		const answer = await readLine();
		if (answer.toLowerCase() !== "y") {
			process.stdout.write("Aborted.\n");
			process.exit(1);
		}

		await killPortProcess(proc.pid);
		await Bun.sleep(400); // wait for OS to release the port
		await startFn();
	}
}
