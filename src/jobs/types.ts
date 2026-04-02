export type JobKind =
  | "memory.migrate"
  | "memory.organize"
  | "task.run"
  | "search.rebuild"
  | "maintenance.replay_projection"
  | "maintenance.rebuild_derived"
  | "maintenance.full";

export type ExecutionClass =
  | "interactive.user_turn"
  | "interactive.delegated_task"
  | "background.memory_migrate"
  | "background.memory_organize"
  | "background.search_rebuild"
  | "background.maintenance_replay"
  | "background.maintenance_rebuild_derived"
  | "background.maintenance_full"
  | "background.autonomy";

export type JobKey = string;

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type Job = {
  jobId: string;
  jobKey: JobKey;
  kind: JobKind;
  executionClass: ExecutionClass;
  sessionId?: string;
  agentId?: string;
  idempotencyKey?: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  retriable: boolean;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  ownershipAccepted: boolean;
};

export const JOB_MAX_ATTEMPTS: Record<JobKind, number> = {
  "memory.migrate": 2,
  "memory.organize": 4,
  "task.run": 1,
  "search.rebuild": 3,
  "maintenance.replay_projection": 2,
  "maintenance.rebuild_derived": 3,
  "maintenance.full": 1,
};

export const CONCURRENCY_CAPS = {
  memory_migrate_per_agent_session: 1,
  memory_organize_global: 2,
  task_run_per_parent: 1,
  search_rebuild_global: 1,
  maintenance_replay_global: 1,
  maintenance_rebuild_derived_global: 1,
  maintenance_full_global: 1,
  chat_completions_global: 4,
  embedding_batches_global: 2,
} as const;

export const EXECUTION_CLASS_PRIORITY: Record<ExecutionClass, number> = {
  "interactive.user_turn": 1,
  "interactive.delegated_task": 2,
  "background.memory_migrate": 3,
  "background.memory_organize": 4,
  "background.search_rebuild": 4,
  "background.maintenance_replay": 4,
  "background.maintenance_rebuild_derived": 4,
  "background.maintenance_full": 5,
  "background.autonomy": 5,
};

export const JOB_STATE_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["completed", "failed", "pending", "cancelled"],
  completed: [],
  failed: ["pending"],
  cancelled: [],
};

export function canTransitionJobStatus(from: JobStatus, to: JobStatus): boolean {
  return JOB_STATE_TRANSITIONS[from].includes(to);
}
