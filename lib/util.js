import { log } from './log.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 帶有額外除錯資訊（detail）的錯誤，會一起放進錯誤回報 */
export class AppError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AppError';
    this.detail = detail;
  }
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError(`${label}：${Math.round(ms / 1000)} 秒沒有回應`, { timeoutMs: ms })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function fetchWithTimeout(url, opts = {}, ms = 20_000, label = '連線') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    const short = String(url).split('?')[0];
    if (e.name === 'AbortError') {
      throw new AppError(`${label}：${Math.round(ms / 1000)} 秒沒有回應`, { url: short, timeoutMs: ms });
    }
    throw new AppError(`${label}：連線失敗（${e.message}）`, { url: short });
  } finally {
    clearTimeout(timer);
  }
}

/** 遞迴找出 JSON 裡所有名為 key 的值（YouTube 回應結構很深又常改版，用這個比寫死路徑耐用） */
export function findAll(obj, key, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) out.push(v);
    findAll(v, key, out);
  }
  return out;
}

export function findFirst(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findFirst(v, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findFirst(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** YouTube 的文字物件：{ runs: [{text}] } 或 { simpleText } */
export const runsText = (t) => t?.runs?.map((r) => r.text).join('') ?? t?.simpleText ?? '';

/** "3:45" / "1:02:03" → 毫秒 */
export function parseDuration(str) {
  if (!str || !/^\d{1,2}(:\d{2}){1,2}$/.test(str.trim())) return undefined;
  return str.trim().split(':').reduce((acc, n) => acc * 60 + Number(n), 0) * 1000;
}

export function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 確保有一個符合 match 的分頁存在且已就緒；沒有就在背景開一個。
 * ready：在該分頁 MAIN world 執行、回傳 true 代表就緒的函式（可省略）。
 */
export async function ensureTab({ match, url, ready, timeoutMs = 30_000, onWait }) {
  const host = new URL(url).host;
  let [tab] = await chrome.tabs.query({ url: match });
  if (!tab) {
    onWait?.(`在背景開啟 ${host}`);
    log('info', `開啟分頁 ${host}`);
    tab = await chrome.tabs.create({ url, active: false });
  }

  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tab.id);
      last = { status: t.status, tabUrl: t.url?.split('?')[0] };
      const nowHost = t.url ? new URL(t.url).host : '';
      if (/accounts\.google\.com|consent\./.test(nowHost)) {
        throw new AppError(`${host} 要求登入或同意 Cookie，請切到那個分頁處理後再試一次`, last);
      }
      if (t.status === 'complete') {
        if (!ready) return tab.id;
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: ready,
        });
        if (result) return tab.id;
        last.ready = false;
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      last.error = e.message;
    }
    await sleep(500);
  }
  throw new AppError(`${host} 分頁 ${Math.round(timeoutMs / 1000)} 秒內沒有準備好`, {
    ...last,
    hint: `請手動打開 ${host} 確認能正常瀏覽`,
  });
}
