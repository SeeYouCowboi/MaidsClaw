export type RoutePolicyScope = "public" | "read" | "write";
export type RoutePolicyErrorTransport = "json" | "sse";

export type RoutePolicy = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS";
  route_pattern: string;
  scope: RoutePolicyScope;
  audit: boolean;
  cors: boolean;
  pg_required: boolean;
  error_transport: RoutePolicyErrorTransport;
};

export const GATEWAY_ROUTE_POLICY_MATRIX: readonly RoutePolicy[] = [
  // Public health probes
  {
    method: "GET",
    route_pattern: "/healthz",
    scope: "public",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/readyz",
    scope: "public",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },

  // Session writes
  {
    method: "POST",
    route_pattern: "/v1/sessions",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "POST",
    route_pattern: "/v1/sessions/{id}/turns:stream",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "sse",
  },
  {
    method: "POST",
    route_pattern: "/v1/sessions/{id}/close",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "POST",
    route_pattern: "/v1/sessions/{id}/recover",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },

  // Persona writes
  {
    method: "POST",
    route_pattern: "/v1/personas",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "PUT",
    route_pattern: "/v1/personas/{id}",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "DELETE",
    route_pattern: "/v1/personas/{id}",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "POST",
    route_pattern: "/v1/personas:reload",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },

  // Lore writes
  {
    method: "POST",
    route_pattern: "/v1/lore",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "PUT",
    route_pattern: "/v1/lore/{lore_id}",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "DELETE",
    route_pattern: "/v1/lore/{lore_id}",
    scope: "write",
    audit: true,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },

  // Read endpoints (explicit list + read fallback)
  {
    method: "GET",
    route_pattern: "/v1/requests/{request_id}/summary",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/requests/{request_id}/prompt",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/requests/{request_id}/chunks",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/requests/{request_id}/diagnose",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/requests/{request_id}/trace",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/requests/{request_id}/retrieval-trace",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/sessions",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/sessions/{session_id}/transcript",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/sessions/{session_id}/memory",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/logs",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/agents",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  // Provider discovery endpoint (redacted effective catalog)
  {
    method: "GET",
    route_pattern: "/v1/providers",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/runtime",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/jobs",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: true,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/jobs/{job_id}",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: true,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/personas",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/personas/{id}",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/lore",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/lore/{lore_id}",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/state/snapshot",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/state/maiden-decisions",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/agents/{agent_id}/memory/core-blocks",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: true,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/agents/{agent_id}/memory/core-blocks/{label}",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: true,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/agents/{agent_id}/memory/episodes",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: true,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/agents/{agent_id}/memory/narratives",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: true,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/agents/{agent_id}/memory/settlements",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: true,
    error_transport: "json",
  },
  {
    method: "GET",
    route_pattern: "/v1/agents/{agent_id}/memory/pinned-summaries",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: true,
    error_transport: "json",
  },

  // Explicit fallback rule: all other GET /v1/** are read scope.
  {
    method: "GET",
    route_pattern: "/v1/**",
    scope: "read",
    audit: false,
    cors: true,
    pg_required: false,
    error_transport: "json",
  },
] as const;

export function normalizeRoutePattern(pattern: string): string {
  return pattern.replace(/\{[^}]+\}/g, "{}");
}

export function routePolicyKey(method: string, routePattern: string): string {
  return `${method.toUpperCase()} ${normalizeRoutePattern(routePattern)}`;
}

export const ROUTE_POLICY = new Map<string, RoutePolicy>(
  GATEWAY_ROUTE_POLICY_MATRIX.map((policy) => [
    routePolicyKey(policy.method, policy.route_pattern),
    policy,
  ]),
);

export function acceptsScope(required: RoutePolicyScope, granted: "read" | "write"): boolean {
  if (required === "public") {
    return true;
  }
  if (required === "read") {
    return granted === "read" || granted === "write";
  }
  return granted === "write";
}
