// Type declarations for Bun test module
declare module "bun:test" {
  type AsyncMatchers = {
    toBe(expected: unknown): Promise<void>;
    toEqual(expected: unknown): Promise<void>;
    toBeUndefined(): Promise<void>;
    toThrow(expected?: string | RegExp | (new (...args: any[]) => any)): Promise<void>;
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
    toBeInstanceOf(ctor: new (...args: any[]) => any): void;
    toMatch(expected: RegExp | string): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string | RegExp | (new (...args: any[]) => any)): void;
    toHaveBeenCalledWith(...expected: unknown[]): void;
    resolves: AsyncMatchers;
    rejects: AsyncMatchers;
    not: Omit<Matchers<T>, "not">;
  };

  type DescribeFn = (name: string, fn: () => void) => void;
  type TestFn = (name: string, fn: () => void | Promise<void>, timeout?: number) => void;

  export const describe: DescribeFn & {
    skip: DescribeFn;
    only: DescribeFn;
    skipIf(condition: boolean): DescribeFn;
    if(condition: boolean): DescribeFn;
  };

  export const it: TestFn & {
    skip: TestFn;
    only: TestFn;
    skipIf(condition: boolean): TestFn;
    if(condition: boolean): TestFn;
  };

  export const test: TestFn & {
    skip: TestFn;
    only: TestFn;
    skipIf(condition: boolean): TestFn;
    if(condition: boolean): TestFn;
  };

  export function expect<T>(value: T): Matchers<T>;
  export namespace expect {
    function any<T = unknown>(ctor: new (...args: any[]) => T | Function): unknown;
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
