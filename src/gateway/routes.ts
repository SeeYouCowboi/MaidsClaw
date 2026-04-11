import type { ControllerContext } from "./controllers.js";
import {
  handleHealthz,
  handleReadyz,
  handleCreateSession,
  handleTurnStream,
  handleCloseSession,
  handleRecoverSession,
  handleRequestSummary,
  handleRequestPrompt,
  handleRequestChunks,
  handleRequestDiagnose,
  handleRequestTrace,
  handleSessionTranscript,
  handleSessionMemory,
  handleLogs,
  handleListJobs,
  handleGetJob,
} from "./controllers.js";

export type RouteHandler = (req: Request, ctx: ControllerContext) => Response | Promise<Response>;

export type RouteEntry = {
  method: string;
  pattern: string;
  handler: RouteHandler;
};

/**
 * Match a URL pathname against a route pattern.
 * Patterns use {param} syntax for path segments (e.g. /v1/sessions/{session_id}/close).
 * Returns true if the path matches the pattern structure.
 */
function matchPath(pathname: string, pattern: string): boolean {
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);

  if (pathParts.length !== patternParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    // {param} matches any non-empty segment
    if (pp.startsWith("{") && pp.endsWith("}")) continue;
    if (pp !== pathParts[i]) return false;
  }
  return true;
}

/** V1 route table — all 5 endpoints */
export const ROUTES: RouteEntry[] = [
  { method: "GET", pattern: "/healthz", handler: (_req) => handleHealthz() },
  { method: "GET", pattern: "/readyz", handler: (req, ctx) => handleReadyz(req, ctx) },
  { method: "POST", pattern: "/v1/sessions", handler: handleCreateSession },
  { method: "POST", pattern: "/v1/sessions/{session_id}/turns:stream", handler: handleTurnStream },
  { method: "POST", pattern: "/v1/sessions/{session_id}/close", handler: handleCloseSession },
  { method: "POST", pattern: "/v1/sessions/{session_id}/recover", handler: handleRecoverSession },
  { method: "GET", pattern: "/v1/requests/{request_id}/summary", handler: handleRequestSummary },
  { method: "GET", pattern: "/v1/requests/{request_id}/prompt", handler: handleRequestPrompt },
  { method: "GET", pattern: "/v1/requests/{request_id}/chunks", handler: handleRequestChunks },
  { method: "GET", pattern: "/v1/requests/{request_id}/diagnose", handler: handleRequestDiagnose },
  { method: "GET", pattern: "/v1/requests/{request_id}/trace", handler: handleRequestTrace },
  { method: "GET", pattern: "/v1/sessions/{session_id}/transcript", handler: handleSessionTranscript },
  { method: "GET", pattern: "/v1/sessions/{session_id}/memory", handler: handleSessionMemory },
  { method: "GET", pattern: "/v1/logs", handler: handleLogs },
  { method: "GET", pattern: "/v1/jobs", handler: handleListJobs },
  { method: "GET", pattern: "/v1/jobs/{job_id}", handler: handleGetJob },
];

/**
 * Route a request to its handler.
 * Returns undefined if no route matches.
 */
export function resolveRoute(
  method: string,
  pathname: string
): RouteEntry | undefined {
  for (const route of ROUTES) {
    if (route.method === method && matchPath(pathname, route.pattern)) {
      return route;
    }
  }
  return undefined;
}
