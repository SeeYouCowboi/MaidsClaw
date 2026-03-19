export type RedactedSettlement = {
  type: string;
  op_count?: number;
  kinds?: string[];
};

export type PrivateCommitSummary = {
  present: boolean;
  op_count: number;
  kinds: string[];
};
