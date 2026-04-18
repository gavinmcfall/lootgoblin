export interface PendingChallenge {
  code: string;
  expires: number;
  approvedKey?: string;
  browserFingerprint?: string;
}

// In-memory store — v1 single-instance. Scale-out would need a pair_challenges table.
export const pendingChallenges = new Map<string, PendingChallenge>();
