import type { RouteEntry } from "../route-definition.js";
import {
	handleListJobs,
	handleGetJobDetail,
} from "../controllers.js";

export const JOB_ROUTES: RouteEntry[] = [
	{ method: "GET", pattern: "/v1/jobs", handler: handleListJobs },
	{ method: "GET", pattern: "/v1/jobs/{job_id}", handler: handleGetJobDetail },
];
