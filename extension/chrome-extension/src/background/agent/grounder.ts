import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';
import { fetchWithTimeout } from '../net';
import { callOrchestrator } from './orchestrator';
import { captureScreenshot, runInPage, GROUNDER_SCREENSHOT_OPTS } from '../perception';
import { getViewportSize } from '../perception/pageScript';

const logger = createLogger('grounder');

// A local vision call (image prefill on a 3B model) is slow but bounded — past
// this the model server is wedged, so fail rather than hang the task
const LOCAL_VISION_TIMEOUT_MS = 60_000;

// Prompt validated in the Phase-0 spike (phase0/run.py): Holo1.5-3B answers
// a plain JSON coordinate request reliably.
function groundingPrompt(width: number, height: number, instruction: string): string {
  return (
    `You are a web UI grounding model. The image is a ${width}x${height} pixel screenshot ` +
    `of a web page. Task: click ${instruction}\n` +
    'Reply with ONLY the pixel coordinates of the single point to click, as ' +
    `JSON: {"x": <int>, "y": <int>}. Coordinates are in image pixels ` +
    `(0,0 = top-left, max x=${width}, max y=${height}).`
  );
}

// Tolerant coordinate parse (mirrors phase0): JSON x/y first, then first number pair
function parseXY(text: string): { x: number; y: number } | null {
  const mx = text.match(/"?x"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const my = text.match(/"?y"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (mx && my) return { x: Number(mx[1]), y: Number(my[1]) };
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (nums && nums.length >= 2) return { x: Number(nums[0]), y: Number(nums[1]) };
  return null;
}

export interface GroundedPoint {
  /** Viewport CSS coordinates, ready for click_at */
  x: number;
  y: number;
  /** The instruction that was localized (trajectory/training metadata) */
  target: string;
}

/**
 * Vision grounding fallback: localize a natural-language target on the
 * current screenshot with the local VLM and return viewport coordinates.
 * ~5s/call (image-prefill bound) — use only when DOM grounding can't.
 */
export async function groundTarget(tabId: number, instruction: string, signal: AbortSignal): Promise<GroundedPoint> {
  const { baseUrl, grounderModel, cloudOnly, navigatorModel } = await chatSettingsStore.getSettings();
  const shot = await captureScreenshot(tabId, GROUNDER_SCREENSHOT_OPTS);
  const base64 = shot.dataUrl.replace(/^data:[^,]+,/, '');

  // Cloud-only mode: the navigator model is GUI-agent-trained — it grounds
  // coordinates from the same screenshots it already judges from
  if (cloudOnly) {
    // One retry on junk coordinates: a single malformed reply (prose, nulls,
    // truncation) should cost one extra call, not fail the step outright —
    // live WhatsApp runs 2026-07-18 died on "returned no coordinates"
    let point = { x: Number.NaN, y: Number.NaN };
    for (let attempt = 0; attempt < 2 && !(Number.isFinite(point.x) && Number.isFinite(point.y)); attempt++) {
      const { value, usage } = await callOrchestrator<{ x: number; y: number }>(
        'You are a web UI grounding model. Reply ONLY with JSON {"x": <int>, "y": <int>} — the pixel coordinates of the single point to click.',
        groundingPrompt(shot.width, shot.height, instruction) +
          (attempt > 0 ? '\nYour previous reply had no usable coordinates — reply with ONLY the JSON object.' : ''),
        signal,
        undefined,
        { imageDataUrl: shot.dataUrl, modelOverride: navigatorModel || undefined, lowLatency: true },
      );
      logger.info(
        `cloud grounding (${usage.model}, try ${attempt + 1}): x=${value.x} y=${value.y} $${usage.cost ?? '?'}`,
      );
      point = { x: Number(value.x), y: Number(value.y) };
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
      throw new Error('Cloud grounder returned no coordinates');
    if (point.x > shot.width || point.y > shot.height) {
      point = { x: (point.x / 1000) * shot.width, y: (point.y / 1000) * shot.height };
    }
    const viewport = await runInPage(tabId, getViewportSize);
    return {
      x: Math.round(point.x * (viewport.width / shot.width)),
      y: Math.round(point.y * (viewport.height / shot.height)),
      target: instruction,
    };
  }

  const response = await fetchWithTimeout(
    `${baseUrl}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: grounderModel,
        messages: [
          {
            role: 'user',
            content: groundingPrompt(shot.width, shot.height, instruction),
            images: [base64],
          },
        ],
        stream: false,
        options: { temperature: 0 },
      }),
    },
    signal,
    LOCAL_VISION_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Grounder request failed (HTTP ${response.status}). Is ${grounderModel} pulled?`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  const content: string = data.message?.content ?? '';
  logger.info('grounder response:', content.slice(0, 120));

  let point = parseXY(content);
  if (!point) throw new Error(`Grounder returned no coordinates: ${content.slice(0, 80)}`);

  // Some VLMs answer in 0-1000 normalized space; detect out-of-image values
  if (point.x > shot.width || point.y > shot.height) {
    point = { x: (point.x / 1000) * shot.width, y: (point.y / 1000) * shot.height };
  }

  // Scale image pixels -> viewport CSS pixels
  const viewport = await runInPage(tabId, getViewportSize);
  const scaleX = viewport.width / shot.width;
  const scaleY = viewport.height / shot.height;
  return {
    x: Math.round(point.x * scaleX),
    y: Math.round(point.y * scaleY),
    target: instruction,
  };
}

/**
 * Local vision verification: answer a question about the CURRENT screenshot
 * with the local VLM. Built for canvas editors (Google Docs/Sheets) whose
 * content is invisible to DOM text extraction — this is the only way to
 * confirm a write landed. Privacy boundary intact: the screenshot stays on
 * the machine; only the text verdict reaches the cloud orchestrator.
 */
export async function verifyVisual(tabId: number, question: string, signal: AbortSignal): Promise<string> {
  const { baseUrl, verifierModel, grounderModel, cloudOnly, navigatorModel } = await chatSettingsStore.getSettings();
  const model = verifierModel || grounderModel;
  const shot = await captureScreenshot(tabId, GROUNDER_SCREENSHOT_OPTS);
  const base64 = shot.dataUrl.replace(/^data:[^,]+,/, '');

  if (cloudOnly) {
    const { value } = await callOrchestrator<{ answer: string }>(
      'You answer a question about a screenshot of a web page. If the question asks whether something is visible/present, start with YES or NO, then quote the relevant visible text. Reply ONLY with JSON {"answer": "<concise answer>"}.',
      `QUESTION: ${question}`,
      signal,
      undefined,
      { imageDataUrl: shot.dataUrl, modelOverride: navigatorModel || undefined, lowLatency: true },
    );
    const answer = (value.answer ?? '').trim();
    logger.info('cloud visual verify:', question.slice(0, 80), '->', answer.slice(0, 160));
    return answer;
  }

  const response = await fetchWithTimeout(
    `${baseUrl}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content:
              `Look at this ${shot.width}x${shot.height} screenshot of a web page and answer the question.\n` +
              `QUESTION: ${question}\n` +
              'If the question asks whether something is visible/present, start your answer with YES or NO, ' +
              'then quote the relevant text you can actually see. Be concise and only describe what is in the image.',
            images: [base64],
          },
        ],
        stream: false,
        options: { temperature: 0 },
      }),
    },
    signal,
    LOCAL_VISION_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Visual verify request failed (HTTP ${response.status}). Is ${model} pulled?`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  const answer: string = (data.message?.content ?? '').trim();
  logger.info('visual verify:', question.slice(0, 80), '->', answer.slice(0, 160));
  return answer;
}
