import { apiPublic } from './api-client';
import { Storage } from './storage';

interface ChallengeResponse { challengeId: string; code: string; }
interface StatusResponse { status: 'pending' | 'approved' | 'expired' | 'unknown'; key?: string; code?: string; }

export async function startPair(serverUrl: string): Promise<{ challengeId: string; code: string }> {
  return apiPublic<ChallengeResponse>(serverUrl, '/api/v1/pair/challenge', { method: 'POST' });
}

export async function pollStatus(serverUrl: string, challengeId: string): Promise<StatusResponse> {
  return apiPublic<StatusResponse>(serverUrl, `/api/v1/pair/status?challengeId=${challengeId}`);
}

export async function completePair(serverUrl: string, apiKey: string): Promise<void> {
  await Storage.setPairing({ serverUrl, apiKey, pairedAt: Date.now() });
}
