import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './types.js';

export type ApprovalRecord = { accountId: string; approvalId: string; fingerprint: string; status: string; previousState?: string | null; finalState?: string | null; createdAt: string; updatedAt: string };
export class ApprovalStore {
  constructor(private readonly root: string) {}
  private file(id: string) { return path.join(this.root, `${createHash('sha256').update(id).digest('hex')}.json`); }
  fingerprint(accountId: string, postUrl: string, action: string, reaction?: string, comment?: string) { return createHash('sha256').update(JSON.stringify({ accountId, postUrl, action, reaction, comment })).digest('hex'); }
  async begin(accountId: string, approvalId: string, fingerprint: string): Promise<{ record: ApprovalRecord; duplicate: boolean }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(approvalId)) throw new ApiError('INVALID_APPROVAL_ID', 'approvalId must be 8-128 URL-safe characters.');
    await mkdir(this.root, { recursive: true }); const file = this.file(approvalId);
    const record: ApprovalRecord = { accountId, approvalId, fingerprint, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    try { const h = await open(file, 'wx', 0o600); await h.writeFile(JSON.stringify(record)); await h.close(); return { record, duplicate: false }; }
    catch (e: unknown) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; const existing = JSON.parse(await readFile(file, 'utf8')) as ApprovalRecord; if (existing.fingerprint !== fingerprint) throw new ApiError('APPROVAL_ID_CONFLICT', 'approvalId was already used for a different action.', 409); return { record: existing, duplicate: true }; }
  }
  async complete(record: ApprovalRecord, status: string, previousState?: string | null, finalState?: string | null): Promise<void> {
    const next = { ...record, status, previousState, finalState, updatedAt: new Date().toISOString() }; const file = this.file(record.approvalId); const temp = `${file}.${process.pid}.tmp`;
    await open(temp, 'w', 0o600).then(async (h) => { await h.writeFile(JSON.stringify(next)); await h.close(); }); await rename(temp, file);
  }
}
