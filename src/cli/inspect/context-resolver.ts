import type { CliContext } from "../context.js";
import type { ParsedArgs } from "../parser.js";

export type InspectContext = {
	requestId?: string;
	sessionId?: string;
	agentId?: string;
};

type ShellContextCarrier = {
	currentRequestId?: string;
	latestRequestId?: string;
	requestId?: string;
	currentSessionId?: string;
	sessionId?: string;
	currentAgentId?: string;
	agentId?: string;
};

export function resolveContext(ctx: CliContext, args: ParsedArgs): InspectContext {
	const shellCtx = ctx as CliContext & ShellContextCarrier;

	const requestId = readFlagString(args, "request")
		?? shellCtx.currentRequestId
		?? shellCtx.latestRequestId
		?? shellCtx.requestId;
	const sessionId = readFlagString(args, "session")
		?? shellCtx.currentSessionId
		?? shellCtx.sessionId;
	const agentId = readFlagString(args, "agent")
		?? shellCtx.currentAgentId
		?? shellCtx.agentId;

	return {
		...(requestId ? { requestId } : {}),
		...(sessionId ? { sessionId } : {}),
		...(agentId ? { agentId } : {}),
	};
}

export function requireRequestId(ctx: InspectContext): string {
	if (!ctx.requestId || ctx.requestId.trim().length === 0) {
		throw new Error("INSPECT_REQUEST_ID_REQUIRED");
	}

	return ctx.requestId;
}

function readFlagString(args: ParsedArgs, key: string): string | undefined {
	const raw = args.flags[key];
	if (typeof raw !== "string") {
		return undefined;
	}

	const normalized = raw.trim();
	return normalized.length > 0 ? normalized : undefined;
}
