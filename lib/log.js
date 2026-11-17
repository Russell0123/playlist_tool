// 執行紀錄：給畫面即時顯示，也給「複製錯誤回報」使用。
// 所有內容都會先遮蔽登入憑證（Bearer token、SAPISIDHASH 等）。

const MAX = 400;
const entries = [];
const listeners = new Set();

const REDACT = [
  [/Bearer\s+[\w\-.~+/]+=*/g, 'Bearer [已隱藏]'],
  [/SAPISID\w*HASH\s+\S+/g, 'SAPISIDHASH [已隱藏]'],
  [/("(?:accessToken|access_token|token|authorization|cookie|clientToken)"\s*:\s*)"[^"]*"/gi, '$1"[已隱藏]"'],
];

export function redact(s) {
  let x = String(s ?? '');
  for (const [re, rep] of REDACT) x = x.replace(re, rep);
  return x;
}

function toText(d) {
  if (d === undefined) return undefined;
  if (typeof d === 'string') return d;
  if (d instanceof Error) {
    return JSON.stringify({
      message: d.message,
      detail: d.detail,
      stack: d.stack?.split('\n').slice(1, 4).map((s) => s.trim()).join(' | '),
    });
  }
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}

export function log(level, msg, data) {
  const text = toText(data);
  const e = {
    t: Date.now(),
    level,
    msg: redact(msg),
    data: text === undefined ? undefined : redact(text).slice(0, 1500),
  };
  entries.push(e);
  if (entries.length > MAX) entries.shift();
  for (const f of listeners) f(e);
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug;
  out(`[${level}] ${e.msg}`, e.data ?? '');
}

export const onLog = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export const getEntries = () => entries.slice();

export function formatEntry(e) {
  const t = new Date(e.t).toTimeString().slice(0, 8);
  return `${t} ${e.level.toUpperCase().padEnd(5)} ${e.msg}${e.data ? `  ${e.data}` : ''}`;
}
