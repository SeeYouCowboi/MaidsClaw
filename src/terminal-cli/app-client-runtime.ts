import {
	type AppUserFacade,
	createGatewayAppClients,
} from "../app/clients/app-clients.js";
import { createAppHost } from "../app/host/index.js";

/**
 * @deprecated Use `createAppHost()` directly instead. This bridge type exists
 * only so that any remaining `createAppClientRuntime()` call sites continue to
 * compile while migration to `AppHost` completes.
 */
export type AppClientRuntime = {
	mode: "local" | "gateway";
	clients: AppUserFacade;
	shutdown: () => void;
};

export async function createAppClientRuntime(params: {
	mode: "local" | "gateway";
	cwd: string;
	baseUrl?: string;
}): Promise<AppClientRuntime> {
	if (params.mode === "gateway") {
		return {
			mode: params.mode,
			clients: createGatewayAppClients(
				params.baseUrl ?? "http://localhost:3000",
			),
			shutdown: () => {},
		};
	}

	const host = await createAppHost({
		role: "local",
		cwd: params.cwd,
		requireAllProviders: false,
	});

	if (!host.user) {
		throw new Error("createAppHost({ role: 'local' }) did not produce a user facade");
	}

	return {
		mode: params.mode,
		clients: host.user,
		shutdown: () => void host.shutdown(),
	};
}
