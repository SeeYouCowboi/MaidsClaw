import { afterEach, describe, expect, it, jest } from "bun:test";
import type { DurableJobStore } from "../../src/jobs/durable-store.js";
import { LeaseReclaimSweeper } from "../../src/jobs/lease-reclaim-sweeper.js";

function createStore(): { store: DurableJobStore; calls: number[] } {
  const calls: number[] = [];
  const store = {
    async reclaimExpiredLeases(nowMs: number): Promise<number> {
      calls.push(nowMs);
      return 1;
    },
  } as unknown as DurableJobStore;

  return { store, calls };
}

describe("LeaseReclaimSweeper", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls reclaimExpiredLeases on configured interval", async () => {
    const { store, calls } = createStore();
    const timerHandle = {} as ReturnType<typeof setInterval>;
    let intervalCallback: (() => void) | undefined;

    jest.spyOn(globalThis, "setInterval").mockImplementation((
      ((handler: TimerHandler): unknown => {
        intervalCallback = handler as () => void;
        return timerHandle;
      }) as unknown as typeof setInterval
    ));
    jest.spyOn(Date, "now").mockReturnValue(1_234);

    const sweeper = new LeaseReclaimSweeper(store, 7);
    sweeper.start();

    expect(intervalCallback).toBeDefined();
    intervalCallback?.();
    await Promise.resolve();

    expect(calls).toEqual([1_234]);
  });

  it("starts and stops cleanly", () => {
    const { store } = createStore();
    const timerHandle = {} as ReturnType<typeof setInterval>;

    const setIntervalSpy = jest
      .spyOn(globalThis, "setInterval")
      .mockImplementation((() => timerHandle) as unknown as typeof setInterval);
    const clearIntervalSpy = jest
      .spyOn(globalThis, "clearInterval")
      .mockImplementation((() => undefined) as typeof clearInterval);

    const sweeper = new LeaseReclaimSweeper(store, 9);
    sweeper.start();
    sweeper.stop();

    expect(setIntervalSpy.mock.calls.length).toBe(1);
    expect(clearIntervalSpy.mock.calls.length).toBe(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timerHandle);
  });

  it("does not double-start", () => {
    const { store } = createStore();
    const setIntervalSpy = jest.spyOn(globalThis, "setInterval");

    const sweeper = new LeaseReclaimSweeper(store, 11);
    sweeper.start();
    sweeper.start();

    expect(setIntervalSpy.mock.calls.length).toBe(1);
  });

  it("is a no-op when stopped before starting", () => {
    const { store } = createStore();
    const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");

    const sweeper = new LeaseReclaimSweeper(store, 13);
    sweeper.stop();

    expect(clearIntervalSpy.mock.calls.length).toBe(0);
  });
});
