export type RateLimitToken = {
  release(): void;
};

export interface RateLimiter {
  acquire(key?: string): Promise<RateLimitToken>;
}

export class NoopRateLimiter implements RateLimiter {
  async acquire(_key?: string): Promise<RateLimitToken> {
    return {
      release(): void {
      },
    };
  }
}
