// Type declarations for Bun test module
declare module "bun:test" {
  type AsyncMatchers = {
    toBe(expected: unknown): Promise<void>;
    toEqual(expected: unknown): Promise<void>;
    toBeUndefined(): Promise<void>;
    toThrow(expected?: string | RegExp): Promise<void>;
  };

  type Matchers<T> = {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toMatch(expected: RegExp | string): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string | RegExp): void;
    toHaveBeenCalledWith(...expected: unknown[]): void;
    resolves: AsyncMatchers;
    rejects: AsyncMatchers;
    not: Omit<Matchers<T>, "not">;
  };

  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function expect<T>(value: T): Matchers<T>;
  export namespace expect {
    function any<T = unknown>(constructor: new (...args: any[]) => T | Function): unknown;
    function objectContaining<T extends object>(value: T): T;
  }
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
