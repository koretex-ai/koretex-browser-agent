import { useState, useEffect } from 'react';
import { accountStore, DEFAULT_ACCOUNT } from '@extension/storage';

interface AccountSettingsProps {
  isDarkMode?: boolean;
}

/**
 * Link to the user's koretex.ai account. Connected = every research run
 * syncs to "My Searches" on the website as it happens. Not connected =
 * nothing is uploaded, extension behaves exactly as before.
 */
export const AccountSettings = ({ isDarkMode = false }: AccountSettingsProps) => {
  void isDarkMode;
  const [connectedEmail, setConnectedEmail] = useState('');
  const [apiBase, setApiBase] = useState(DEFAULT_ACCOUNT.apiBase);
  const [codeInput, setCodeInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    accountStore.get().then(cfg => {
      setConnectedEmail(cfg.email);
      setApiBase(cfg.apiBase);
    });
  }, []);

  const connect = async () => {
    const token = codeInput.trim();
    const base = apiBase.trim().replace(/\/+$/, '');
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      // Validate the code against the site before storing it.
      const res = await fetch(`${base}/api/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError('That code was not accepted. Generate a fresh one on the website and try again.');
        return;
      }
      const email = data.user?.email ?? '(unknown)';
      await accountStore.connect(token, email, base);
      setConnectedEmail(email);
      setCodeInput('');
    } catch {
      setError(`Could not reach ${base}. Is the site URL right?`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await accountStore.disconnect();
    setConnectedEmail('');
  };

  const inputClass =
    'mt-1 w-full rounded-md border border-[#3D3D3D]/60 bg-black px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-gray-400 focus:outline-none';

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-400">
        Connect your koretex.ai account and every search the agent runs is saved to{' '}
        <span className="text-gray-200">My Searches</span> on the website — viewable, sortable and exportable from
        any device.
      </p>

      {connectedEmail ? (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4">
          <p className="text-sm text-green-400">Connected as {connectedEmail}</p>
          <p className="mt-1 text-xs text-gray-500">Syncing to {apiBase}</p>
          <p className="mt-2 text-xs text-gray-500">
            Prospecting is run from your dashboard — open{' '}
            <span className="text-gray-300">{apiBase.replace(/\/+$/, '')}/dashboard/prospects</span>.
          </p>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="mt-3 rounded-md border border-[#3D3D3D]/60 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-red-500/50">
            Disconnect
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-300" htmlFor="account-api-base">
              Website URL
            </label>
            <input
              id="account-api-base"
              type="text"
              value={apiBase}
              onChange={e => setApiBase(e.target.value)}
              placeholder="https://koretex.ai"
              className={inputClass}
            />
          </div>
          <div>
            <label className="text-sm text-gray-300" htmlFor="account-code">
              Connect code
            </label>
            <p className="text-xs text-gray-500">
              Get it from <span className="text-gray-300">{apiBase.replace(/\/+$/, '')}/connect-extension</span>
            </p>
            <input
              id="account-code"
              type="password"
              value={codeInput}
              onChange={e => setCodeInput(e.target.value)}
              placeholder="Paste your connect code"
              className={inputClass}
            />
          </div>
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy || !codeInput.trim()}
            className="rounded-md bg-[#E8E8E8] px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-white disabled:opacity-50">
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      )}
    </div>
  );
};
