import type { RuntimeBootstrapResult } from "../bootstrap/types.js";
import type { TurnExecutionResult } from "../app/contracts/execution.js";
import { InteractionStore } from "../interaction/store.js";
import {
  executeLocalTurn,
  type LocalTurnParams,
} from "../app/clients/local/local-turn-client.js";

export type { LocalTurnParams };

export class LocalRuntime {
  private readonly interactionStore: InteractionStore;

  constructor(private readonly runtime: RuntimeBootstrapResult) {
    this.interactionStore = new InteractionStore(runtime.db);
  }

  async executeTurn(params: LocalTurnParams): Promise<TurnExecutionResult> {
    return executeLocalTurn(params, {
      sessionService: this.runtime.sessionService,
      turnService: this.runtime.turnService,
      interactionStore: this.interactionStore,
      traceStore: this.runtime.traceStore,
    });
  }
}

export function createLocalRuntime(runtime: RuntimeBootstrapResult): LocalRuntime {
  return new LocalRuntime(runtime);
}
