export type InspectContext = {
  requestId?: string;
  sessionId?: string;
  agentId?: string;
};

export type RedactedSettlement = {
  type: string;
  op_count?: number;
  kinds?: string[];
};

export type PrivateCognitionSummary = {
  present: boolean;
  op_count: number;
  kinds: string[];
};
