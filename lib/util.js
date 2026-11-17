export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
export async function ensureTab({ match, url, ready, timeoutMs = 30_000 }) {
  let [tab] = await chrome.tabs.query({ url: match });
  if (!tab) tab = await chrome.tabs.create({ url, active: false });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === 'complete') {
        if (!ready) return tab.id;
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: ready,
        });
        if (result) return tab.id;
      }
    } catch {
      /* 分頁還在載入或被關掉，繼續等 */
    }
    await sleep(500);
  }
  throw new Error(`無法開啟 ${url}，請確認可以正常瀏覽該網站後重試`);
}
