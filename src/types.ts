export type SessionStatus = 'idle' | 'starting' | 'browser_ready' | 'manual_intervention_required' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'session_expired' | 'outcome_unknown';

export interface WorkerResponse {
  accountId: string;
  sessionId: string | null;
  status: SessionStatus;
  viewerUrl: string | null;
  loggedIn: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  requestId?: string;
  result?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
  }
}
