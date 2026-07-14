/**
 * fetch with a hard timeout, composed with the task's cancel signal.
 *
 * A model call with no timeout is a silent forever-hang: if the connection
 * stalls (network drop, provider wedge), the task waits with no way to break
 * out. This wraps fetch so a stall becomes a clean, catchable error the
 * conductor can reflect on, report, or persist as resumable — never an
 * eternal spinner. User cancellation (parentSignal) is preserved and remains
 * distinguishable from a timeout: on cancel the error propagates as an
 * AbortError; on timeout it is a plain Error with a clear message.
 */
/**
 * Race any promise against a timeout. For awaited operations that are NOT
 * fetch — chrome.scripting.executeScript, captureVisibleTab — which can hang
 * forever if the target tab's content process is unresponsive. Nothing the
 * conductor awaits may block indefinitely; a hang becomes a labeled error.
 * (The underlying operation is not cancelled, only stopped-waiting-on — that
 * is harmless for idempotent reads.)
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal.reason);

  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    // A timeout fires while the PARENT signal is NOT aborted — surface it as a
    // real error so callers (which treat parentSignal.aborted as "cancelled")
    // handle it as a failure, not a silent stop
    if (timedOut && !parentSignal.aborted) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s (no response from the model endpoint)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParentAbort);
  }
}
