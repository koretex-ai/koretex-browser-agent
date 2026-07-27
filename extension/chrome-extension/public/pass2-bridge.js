/**
 * Bridge between the Koretex dashboard and the extension.
 *
 * The prospecting controls belong on the dashboard, but only the extension can
 * drive the browser. This content script runs on our own site and relays a
 * narrow, fixed set of messages between the page and the background worker.
 *
 * Deliberately closed: only the message types listed below cross the boundary,
 * and only when they originate from this page itself.
 */
(() => {
  const ALLOWED = new Set(['pass2_run_sitting', 'pass2_progress', 'pass2_stop']);
  const SOURCE_PAGE = 'koretex-page';
  const SOURCE_EXT = 'koretex-extension';

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE_PAGE || typeof data.type !== 'string') return;
    if (!ALLOWED.has(data.type)) return;

    try {
      chrome.runtime.sendMessage({ type: data.type, count: data.count }, response => {
        // A sleeping service worker is normal, not an error worth surfacing.
        const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : undefined;
        window.postMessage(
          { source: SOURCE_EXT, id: data.id, type: data.type, response: error ? null : response, error },
          window.location.origin,
        );
      });
    } catch (e) {
      window.postMessage(
        { source: SOURCE_EXT, id: data.id, type: data.type, response: null, error: String(e) },
        window.location.origin,
      );
    }
  });

  // Announce presence so the dashboard can distinguish "extension not installed"
  // from "installed but idle".
  const announce = () =>
    window.postMessage({ source: SOURCE_EXT, type: 'pass2_ready' }, window.location.origin);
  announce();
  document.addEventListener('DOMContentLoaded', announce);
})();
