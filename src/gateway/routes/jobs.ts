import {
	GatewayNoBodyRequestSchema,
	JobDetailResponseSchema,
	JobListResponseSchema,
} from "../../contracts/cockpit/browser.js";
import { handleGetJobDetail, handleListJobs } from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const JOB_ROUTES: RouteEntry[] = [
	{
		method: "GET",
		pattern: "/v1/jobs",
		handler: handleListJobs,
		scope: "read",
		audit: false,
		cors: true,
		pgRequired: true,
		errorTransport: "json",
		requestSchema: GatewayNoBodyRequestSchema,
		responseSchema: JobListResponseSchema,
	},
	{
		method: "GET",
		pattern: "/v1/jobs/{job_id}",
		handler: handleGetJobDetail,
		scope: "read",
		audit: false,
		cors: true,
		pgRequired: true,
		errorTransport: "json",
		requestSchema: GatewayNoBodyRequestSchema,
		responseSchema: JobDetailResponseSchema,
	},
];
