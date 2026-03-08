// Type declarations for Bun test module
declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function expect<T>(value: T): {
    toBe(expected: T): void;
    toEqual(expected: T): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toMatch(expected: RegExp | string): void;
    toContain(expected: T extends Array<infer U> ? U : T): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string | RegExp): void;
    resolves: {
      toBe(expected: T): Promise<void>;
      toEqual(expected: T): Promise<void>;
    };
    rejects: {
      toBe(expected: T): Promise<void>;
      toEqual(expected: T): Promise<void>;
      toThrow(expected?: string | RegExp): Promise<void>;
    };
  };
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function mock<T extends (...args: any[]) => any>(fn: T): T & {
    mock: {
      calls: Array<Parameters<T>>;
      results: Array<{ type: "return" | "throw"; value: any }>;
    };
  };
}
