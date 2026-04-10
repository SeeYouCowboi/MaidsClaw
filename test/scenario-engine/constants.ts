export const SCENARIO_ENGINE_BASE_TIME = 1_730_000_000_000;
export const SCENARIO_EMBEDDING_DIM = 1536;
export const SCENARIO_DEFAULT_AGENT_ID = "scenario-engine-agent";
export const SCENARIO_DEFAULT_SESSION_ID = "scenario-engine-session";

/**
 * Live scenario tests (real LLM calls) are expensive (~30–60 min wall clock,
 * real API spend) and MUST NOT run in regular PR CI. They only run when the
 * user explicitly opts in via `SCENARIO_LIVE_TESTS=1` (manual/nightly) or
 * `CI_NIGHTLY=1` (scheduled job). Even when opted in, the test file also
 * checks that at least one LLM API key is present.
 */
export const scenarioLiveTestsEnabled: boolean =
  process.env.SCENARIO_LIVE_TESTS === "1" ||
  process.env.SCENARIO_LIVE_TESTS === "true" ||
  process.env.CI_NIGHTLY === "1" ||
  process.env.CI_NIGHTLY === "true";
