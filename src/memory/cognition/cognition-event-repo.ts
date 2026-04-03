import type { CognitionKind } from "../../runtime/rp-turn-contract.js";

export type CognitionEventAppendParams = {
  agentId: string;
  cognitionKey: string;
  kind: CognitionKind;
  op: "upsert" | "retract";
  recordJson: string | null;
  settlementId: string;
  committedTime: number;
};

export type CognitionEventRow = {
  id: number;
  agent_id: string;
  "cognition_key": string;
  kind: string;
  op: string;
  record_json: string | null;
  settlement_id: string;
  committed_time: number;
  created_at: number;
};
