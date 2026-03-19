import type { DiagnosticEntry } from "../../app/diagnostics/diagnose-service.js";
import type {
	ChunksView,
	LogsView,
	MemoryView,
	PromptView,
	SummaryView,
	TraceView,
	TranscriptView,
} from "../../app/inspect/view-models.js";

export function renderJson(viewModel: unknown): string {
	return JSON.stringify(viewModel, null, 2);
}

export function renderText(
	viewModel:
		| SummaryView
		| TranscriptView
		| PromptView
		| ChunksView
		| LogsView
		| MemoryView
		| TraceView
		| DiagnosticEntry,
): string {
	if (isSummaryView(viewModel)) {
		return [
			`request_id: ${viewModel.request_id}`,
			`session_id: ${viewModel.session_id ?? "unknown"}`,
			`agent_id: ${viewModel.agent_id ?? "unknown"}`,
			`has_public_reply: ${String(viewModel.has_public_reply)}`,
			`private_commit_count: ${viewModel.private_commit_count}`,
			`recovery_required: ${String(viewModel.recovery_required)}`,
			`pending_sweep_status: ${viewModel.pending_sweep_state.status ?? "none"}`,
			...(viewModel.error
				? [
					`error_code: ${viewModel.error.code ?? "unknown"}`,
					`error_message: ${viewModel.error.message}`,
				]
				: []),
		].join("\n");
	}

	if (isTranscriptView(viewModel)) {
		const body = viewModel.entries
			.map((entry) => {
				const base = `[${entry.record_index}] ${entry.actor}/${entry.record_type}`;
				if (entry.text !== undefined) {
					return `${base}: ${entry.text}`;
				}
				if (entry.payload !== undefined) {
					return `${base}: ${JSON.stringify(entry.payload)}`;
				}
				return base;
			})
			.join("\n");
		return `session_id: ${viewModel.session_id}\n${body}`;
	}

	if (isPromptView(viewModel)) {
		return [
			`request_id: ${viewModel.request_id}`,
			`rendered_system_prompt:\n${viewModel.rendered_system_prompt ?? "(unavailable)"}`,
			`conversation_messages: ${viewModel.conversation_messages.length}`,
			...(viewModel.recent_cognition
				? [`recent_cognition:\n${viewModel.recent_cognition}`]
				: []),
		].join("\n\n");
	}

	if (isChunksView(viewModel)) {
		return [
			`request_id: ${viewModel.request_id}`,
			...viewModel.chunks.map(
				(chunk) =>
					`[${chunk.index}] ${chunk.type}${chunk.preview ? `: ${chunk.preview}` : ""}`,
			),
		].join("\n");
	}

	if (isLogsView(viewModel)) {
		return viewModel.entries
			.map(
				(entry) =>
					`${entry.timestamp} [${entry.level}] req=${entry.request_id} sess=${entry.session_id} ${entry.message}`,
			)
			.join("\n");
	}

	if (isMemoryView(viewModel)) {
		return [
			`session_id: ${viewModel.session_id}`,
			`agent_id: ${viewModel.agent_id ?? "unknown"}`,
			`memory_pipeline: ${viewModel.memory_pipeline.status}`,
			`core_memory_blocks: ${viewModel.core_memory_summary.length}`,
			`pending_sweeper: ${viewModel.pending_sweeper_state.status ?? "none"}`,
		].join("\n");
	}

	if (isTraceView(viewModel)) {
		return [
			`request_id: ${viewModel.request_id}`,
			`unsafe_raw_settlement_mode: ${String(viewModel.unsafe_raw_settlement_mode)}`,
			`has_trace: ${String(Boolean(viewModel.bundle.trace))}`,
			`has_interaction_settlement: ${String(Boolean(viewModel.bundle.interaction_settlement))}`,
		].join("\n");
	}

	return [
		`subsystem: ${viewModel.subsystem}`,
		`primary_cause: ${viewModel.primary_cause}`,
		`locator: ${viewModel.locator ?? "unknown"}`,
		`next_commands:`,
		...viewModel.next_commands.map((command) => `- ${command}`),
	].join("\n");
}

function isSummaryView(value: unknown): value is SummaryView {
	return Boolean(value && typeof value === "object" && "request_id" in value && "settlement" in value);
}

function isTranscriptView(value: unknown): value is TranscriptView {
	return Boolean(value && typeof value === "object" && "entries" in value && "session_id" in value);
}

function isPromptView(value: unknown): value is PromptView {
	return Boolean(value && typeof value === "object" && "conversation_messages" in value);
}

function isChunksView(value: unknown): value is ChunksView {
	return Boolean(value && typeof value === "object" && "public_only" in value && "chunks" in value);
}

function isLogsView(value: unknown): value is LogsView {
	return Boolean(value && typeof value === "object" && "filters" in value && "entries" in value);
}

function isMemoryView(value: unknown): value is MemoryView {
	return Boolean(value && typeof value === "object" && "memory_pipeline" in value && "core_memory_summary" in value);
}

function isTraceView(value: unknown): value is TraceView {
	return Boolean(value && typeof value === "object" && "unsafe_raw_settlement_mode" in value && "bundle" in value);
}
