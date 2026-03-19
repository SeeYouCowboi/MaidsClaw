import type { ObservationEvent } from "../contracts/execution.js";

export type TurnRequest = {
  sessionId: string;
  text: string;
  agentId?: string;
  requestId: string;
  saveTrace?: boolean;
};

export interface TurnClient {
  streamTurn(params: TurnRequest): AsyncIterable<ObservationEvent>;
}
