export type SessionStatus = 'idle' | 'active' | 'logged_in' | 'cancelled' | 'expired' | 'error';

export interface WorkerResponse {
  accountId: string;
  sessionId: string | null;
  status: SessionStatus;
  viewerUrl: string | null;
  loggedIn: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
  }
}
