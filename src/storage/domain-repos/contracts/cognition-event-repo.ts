import type {
  CognitionEventAppendParams,
  CognitionEventRow,
} from "../../../memory/cognition/cognition-event-repo.js";

export interface CognitionEventRepo {
  append(params: CognitionEventAppendParams): Promise<number | null>;
  readByAgent(agentId: string, limit?: number): Promise<CognitionEventRow[]>;
  readByCognitionKey(agentId: string, cognitionKey: string): Promise<CognitionEventRow[]>;
  replay(agentId: string, afterTime?: number): Promise<CognitionEventRow[]>;
}
