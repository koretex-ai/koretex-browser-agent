import type { PerceptionSnapshot } from '@extension/storage';
import { createLogger } from '../log';
import { extractInteractiveElements, removeHighlights } from './pageScript';
import type { ExtractedPageState } from './pageScript';

const logger = createLogger('perception');

// Latency is image-prefill bound (~5s/call at full res on the M3 Pro), so
// downscaling is a first-class lever: cap width and recompress aggressively.
const MAX_SCREENSHOT_WIDTH = 1024;
const SCREENSHOT_JPEG_QUALITY = 0.7;
// The grounder input MUST be >=1280px wide: below Qwen2.5-VL's processing
// budget (~860k px) the model answers in an internally upscaled coordinate
// space and every click lands progressively below/right of the target
// (measured 2026-07-10: +180px y-error at 1024w vs <=10px at 1280w).
export const GROUNDER_SCREENSHOT_OPTS = { maxWidth: 1280, quality: 0.85 };

async function runInPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  ...args: Args
): Promise<Result> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args as never,
  });
  return injection?.result as Result;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export interface Screenshot {
  dataUrl: string;
  /** Image dimensions in pixels (after downscaling) */
  width: number;
  height: number;
}

async function downscaleDataUrl(dataUrl: string, maxWidth: number, quality: number): Promise<Screenshot> {
  const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, maxWidth / source.width);
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(source, 0, 0, width, height);
  source.close();

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { dataUrl: await blobToDataUrl(blob), width, height };
}

export async function captureScreenshot(
  tabId: number,
  opts: { maxWidth?: number; quality?: number } = {},
): Promise<Screenshot> {
  const tab = await chrome.tabs.get(tabId);
  const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
  return downscaleDataUrl(raw, opts.maxWidth ?? MAX_SCREENSHOT_WIDTH, opts.quality ?? SCREENSHOT_JPEG_QUALITY);
}

// Capture the hybrid perception snapshot: DOM set-of-marks AND pixels together,
// so every trajectory step carries the vision-superset training data.
// The most recent snapshot — the state whose element indices the in-page
// registry currently holds. Actions must log against THIS, never re-extract
// (a second extraction rebuilds the registry and invalidates chosen indices).
let lastSnapshot: PerceptionSnapshot | null = null;

export function getLastSnapshot(): PerceptionSnapshot | null {
  return lastSnapshot;
}

export async function capturePageState(tabId: number, showHighlights: boolean): Promise<PerceptionSnapshot> {
  const dom: ExtractedPageState = await runInPage(tabId, extractInteractiveElements, showHighlights);
  if (!dom) throw new Error('DOM extraction returned no result — is this a restricted page (chrome://, Web Store)?');

  const screenshot = await captureScreenshot(tabId);
  logger.info('captured page state', dom.url, `${dom.elements.length} elements`);

  lastSnapshot = {
    url: dom.url,
    title: dom.title,
    scroll: dom.scroll,
    elements: dom.elements,
    screenshot: screenshot.dataUrl,
    capturedAt: Date.now(),
  };
  return lastSnapshot;
}

export async function clearHighlights(tabId: number): Promise<void> {
  await runInPage(tabId, removeHighlights);
}

export { runInPage };
