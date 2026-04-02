import type {
  CognitionCurrentRow,
} from "../../../memory/cognition/private-cognition-current.js";
import type { CognitionEventRow } from "../../../memory/cognition/cognition-event-repo.js";

export interface CognitionProjectionRepo {
  upsertFromEvent(event: CognitionEventRow): Promise<void>;
  rebuild(agentId: string): Promise<void>;
  getCurrent(agentId: string, cognitionKey: string): Promise<CognitionCurrentRow | null>;
  getAllCurrent(agentId: string): Promise<CognitionCurrentRow[]>;
}
