/**
 * Blackboard — Reserved Interface (V1 Stub)
 *
 * V1 stub: SimpleBlackboard implemented in src/state/blackboard.ts
 * V2+ full: event-bus notified changes, persistence to SQLite, typed schemas per namespace.
 *
 * All calling code should depend on this interface type, not the concrete class,
 * so implementations can be swapped by changing one line in the DI/config setup.
 */
export interface Blackboard {
  set(key: string, value: unknown, caller?: string): void;
  get<T = unknown>(key: string): T | undefined;
  delete(key: string, caller?: string): boolean;
  has(key: string): boolean;
  keys(): string[];
}
