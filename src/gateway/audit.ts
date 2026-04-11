import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MaidsClawError } from "../core/errors.js";

export type AuditRecord = {
	ts: number;
	request_id: string;
	method: string;
	path: string;
	route_pattern?: string;
	status: number;
	duration_ms: number;
	origin?: string;
	principal_id?: string;
	scopes?: string[];
	result: "ok" | "error";
	body_keys?: string[];
	query_keys?: string[];
};

export async function initAudit(dataDir: string): Promise<void> {
	const auditDir = join(dataDir, "audit");
	try {
		await mkdir(auditDir, { recursive: true });
	} catch {
		throw new MaidsClawError({
			code: "AUDIT_WRITE_FAILED",
			message: "Failed to initialize gateway audit directory",
			retriable: false,
		});
	}
}

export async function appendAuditRecord(
	filePath: string,
	record: AuditRecord,
): Promise<void> {
	try {
		await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf-8");
	} catch (error) {
		console.error("[gateway:audit] append failed", {
			path: filePath,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
