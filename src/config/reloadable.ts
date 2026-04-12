export type ReloadResult<T = unknown> =
  | {
      ok: true;
      snapshot: T;
      version: number;
      previousVersion: number;
    }
  | {
      ok: false;
      error: Error;
      snapshot: T;
      version: number;
      rolledBackToVersion: number;
    };

export interface VersionedSnapshot<T> {
  version: number;
  snapshot: T;
}

export interface ReloadableSnapshot<T> {
  get(): T;
  getVersion(): number;
  getSnapshot(): VersionedSnapshot<T>;
  reload(): Promise<ReloadResult<T>>;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function createReloadable<T>(options: {
  load: () => Promise<T>;
  initial: T;
  onReloadError?: (err: Error) => void;
}): ReloadableSnapshot<T> {
  let state: VersionedSnapshot<T> = {
    version: 1,
    snapshot: options.initial,
  };
  const onReloadError =
    options.onReloadError ??
    ((error: Error) => {
      console.error(error);
    });

  return {
    get(): T {
      return state.snapshot;
    },

    getVersion(): number {
      return state.version;
    },

    getSnapshot(): VersionedSnapshot<T> {
      return {
        version: state.version,
        snapshot: state.snapshot,
      };
    },

    async reload(): Promise<ReloadResult<T>> {
      const previous = state;
      try {
        const nextSnapshot = await options.load();
        state = {
          version: previous.version + 1,
          snapshot: nextSnapshot,
        };
        return {
          ok: true,
          snapshot: nextSnapshot,
          version: state.version,
          previousVersion: previous.version,
        };
      } catch (error) {
        const normalizedError = toError(error);
        try {
          onReloadError(normalizedError);
        } catch {
          // Error reporting should not alter reload result.
        }
        state = previous;
        return {
          ok: false,
          error: normalizedError,
          snapshot: state.snapshot,
          version: state.version,
          rolledBackToVersion: state.version,
        };
      }
    },
  };
}
