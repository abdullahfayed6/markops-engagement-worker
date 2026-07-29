import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './types.js';

const ACCOUNT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertAccountId(accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new ApiError('INVALID_ACCOUNT_ID', 'accountId must be 1-64 letters, numbers, underscores, or hyphens.', 400);
  return accountId;
}

export class AccountLockManager {
  constructor(private readonly profileRoot: string) {}

  profilePath(accountId: string): string { return path.join(this.profileRoot, assertAccountId(accountId)); }
  private lockPath(accountId: string): string { return path.join(this.profileRoot, `${assertAccountId(accountId)}.lock`); }

  async acquire(accountId: string, sessionId: string): Promise<() => Promise<void>> {
    await mkdir(this.profileRoot, { recursive: true });
    const lockPath = this.lockPath(accountId);
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ sessionId, pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        let detail = 'another worker or browser session holds this account profile';
        try { detail = `profile is locked: ${(await readFile(lockPath, 'utf8')).slice(0, 300)}`; } catch { /* retain default */ }
        throw new ApiError('ACCOUNT_BUSY', detail, 409);
      }
      throw error;
    }
    let released = false;
    return async () => {
      if (!released) {
        released = true;
        await rm(lockPath, { force: true });
      }
    };
  }

  async removeProfile(accountId: string): Promise<void> {
    const profile = this.profilePath(accountId);
    const lock = this.lockPath(accountId);
    try { await readFile(lock); throw new ApiError('ACCOUNT_BUSY', 'Cannot delete an account with an active profile lock.', 409); } catch (error) {
      if (error instanceof ApiError) throw error;
    }
    await rm(profile, { recursive: true, force: true });
  }
}
