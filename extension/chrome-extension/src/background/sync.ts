import { accountStore } from '@extension/storage';
import { createLogger } from './log';

const logger = createLogger('sync');

/**
 * Uploads a run's results to the user's koretex.ai account ("My Searches")
 * while the agent works. Fire-and-forget by design: every network call is
 * caught and logged — sync must never slow down or break a run. When no
 * account is connected, createRunSync returns null and the run behaves
 * exactly as before.
 *
 * Rows are keyed by a stable externalId so re-pushes upsert instead of
 * duplicating, and a resumed run (same clientRunId) continues the same run
 * on the website.
 */

export interface RunSnapshot {
  /** Declared table columns, when the run is in schema mode. */
  columns: string[] | null;
  /** Schema mode: the live row objects (keyed by column name). */
  rows: Array<Record<string, string>>;
  /** Free-text mode: the deduped collection lines. */
  collection: string[];
}

export interface RunSyncHandle {
  /** Push any rows that changed since the last push. Debounced by the caller's interval. */
  flush: () => Promise<void>;
  /** Final flush + status update. Safe to call once at the end of the run. */
  finish: (status: 'COMPLETED' | 'FAILED' | 'STOPPED', message?: string) => Promise<void>;
  stop: () => void;
}

const PUSH_INTERVAL_MS = 4000;
const MAX_BATCH = 200;

const rowKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 60) || 'item';

/** Free-text lines sync as single-column rows keyed by their entity head. */
const lineToRow = (line: string): { externalId: string; data: Record<string, string> } => {
  const head = line.split(/\s+—\s+|\s+-\s+/)[0] ?? line;
  return { externalId: rowKey(head.slice(0, 80)), data: { item: line } };
};

export async function createRunSync(
  clientRunId: string,
  title: string,
  prompt: string,
  snapshot: () => RunSnapshot,
): Promise<RunSyncHandle | null> {
  const account = await accountStore.get();
  if (!account.token) return null;

  const base = account.apiBase.replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${account.token}`,
    'Content-Type': 'application/json',
  };

  let runId: string | null = null;
  let columnsSent: string | null = null;
  const sent = new Map<string, string>(); // externalId -> JSON of last pushed data
  let inFlight = false;

  const api = async (path: string, method: string, body: unknown): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data?.success) {
        logger.warning(`sync ${method} ${path} -> ${res.status}`);
        return null;
      }
      return data;
    } catch (error) {
      logger.warning(`sync ${method} ${path} failed:`, error);
      return null;
    }
  };

  // Create the run up front so the website shows it while the agent works.
  const created = await api('/api/runs', 'POST', {
    clientRunId,
    title: title.slice(0, 200),
    prompt,
  });
  if (!created) return null; // site unreachable — run proceeds unsynced
  runId = (created.run as { id: string }).id;
  logger.info(`run synced to account: ${runId}`);

  const flush = async (): Promise<void> => {
    if (!runId || inFlight) return;
    inFlight = true;
    try {
      const snap = snapshot();

      // Declare/refresh columns once the schema is known.
      const columns = snap.columns?.length
        ? snap.columns.map(c => ({ key: c, label: c }))
        : [{ key: 'item', label: 'Item' }];
      const columnsJson = JSON.stringify(columns);
      if (columnsJson !== columnsSent) {
        const ok = await api(`/api/runs/${runId}`, 'PATCH', { columns });
        if (ok) columnsSent = columnsJson;
      }

      const entries = snap.columns?.length
        ? snap.rows.map(row => ({
            externalId: rowKey(row[snap.columns![0]] ?? ''),
            data: row,
          }))
        : snap.collection.map(lineToRow);

      const changed = entries.filter(e => sent.get(e.externalId) !== JSON.stringify(e.data));
      if (changed.length === 0) return;

      for (let i = 0; i < changed.length; i += MAX_BATCH) {
        const batch = changed.slice(i, i + MAX_BATCH);
        const ok = await api(`/api/runs/${runId}/rows`, 'POST', { rows: batch });
        if (!ok) return; // leave unsent entries for the next flush
        for (const e of batch) sent.set(e.externalId, JSON.stringify(e.data));
      }
    } finally {
      inFlight = false;
    }
  };

  const interval = setInterval(() => void flush(), PUSH_INTERVAL_MS);

  return {
    flush,
    finish: async (status, message) => {
      clearInterval(interval);
      await flush();
      if (runId) await api(`/api/runs/${runId}`, 'PATCH', { status, statusMessage: message ?? null });
    },
    stop: () => clearInterval(interval),
  };
}
