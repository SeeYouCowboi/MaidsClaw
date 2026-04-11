export type ReloadResult<T = unknown> =
	| { ok: true; snapshot: T }
	| { ok: false; error: Error };

export interface ReloadableSnapshot<T> {
	get(): T;
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
	let current = options.initial;
	const onReloadError =
		options.onReloadError ??
		((error: Error) => {
			console.error(error);
		});

	return {
		get(): T {
			return current;
		},

		async reload(): Promise<ReloadResult<T>> {
			try {
				const nextSnapshot = await options.load();
				current = nextSnapshot;
				return { ok: true, snapshot: nextSnapshot };
			} catch (error) {
				const normalizedError = toError(error);
				try {
					onReloadError(normalizedError);
				} catch {
					// Error reporting should not alter reload result.
				}
				return { ok: false, error: normalizedError };
			}
		},
	};
}
