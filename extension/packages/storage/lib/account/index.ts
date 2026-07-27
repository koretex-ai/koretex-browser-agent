import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Link to the user's koretex.ai account. When connected, finished/streaming
// research results are synced to the website ("My Searches"); when not
// connected, nothing is uploaded and the extension behaves exactly as before.
export interface AccountConfig {
  /** Long-lived JWT minted by the site's /connect-extension page. Empty = not connected. */
  token: string;
  /** Email shown in settings so the user knows which account is linked. */
  email: string;
  /** Site origin the extension syncs to. */
  apiBase: string;
}

// Default to production: downloaded builds go to real users, and a localhost
// default reads as an error to them. Developers change the field to their dev
// server when testing locally.
export const DEFAULT_ACCOUNT: AccountConfig = {
  token: '',
  email: '',
  apiBase: 'https://koretex.ai',
};

export type AccountStorage = BaseStorage<AccountConfig> & {
  isConnected: () => Promise<boolean>;
  connect: (token: string, email: string, apiBase: string) => Promise<void>;
  disconnect: () => Promise<void>;
};

const storage = createStorage<AccountConfig>('account-settings', DEFAULT_ACCOUNT);

export const accountStore: AccountStorage = {
  ...storage,
  isConnected: async () => {
    const cfg = await storage.get();
    return Boolean(cfg.token);
  },
  connect: async (token, email, apiBase) => {
    await storage.set({ token, email, apiBase });
  },
  disconnect: async () => {
    const cfg = await storage.get();
    await storage.set({ ...DEFAULT_ACCOUNT, apiBase: cfg.apiBase });
  },
};
