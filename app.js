// 主畫面流程：讀取來源 → 逐首配對 → 使用者確認 → 建立清單
// 每個步驟都即時回報進度；任何錯誤都能「複製錯誤回報」。

import { spotify } from './lib/spotify.js';
import { ytmusic } from './lib/ytmusic.js';
import { youtube } from './lib/youtube.js';
import { parsePlaylistUrl, parseTrackUrl, PLATFORM_LABELS } from './lib/platforms.js';
import { classify } from './lib/match.js';
import { sleep, formatDuration, AppError } from './lib/util.js';
import { log, onLog, getEntries, formatEntry, redact } from './lib/log.js';

const VERSION = chrome.runtime.getManifest().version;
const ADAPTERS = { spotify, ytmusic, youtube };
const SEARCH_DELAY_MS = 300;       // 每首之間稍停，避免被平台限流
const MAX_CONSECUTIVE_ERRORS = 3;  // 連續失敗幾首就自動停止
const SLOW_SECONDS = 10;           // 單一動作超過幾秒就標示「等待較久」

const $ = (id) => document.getElementById(id);
const STEP_NAMES = { load: '讀取', match: '配對', create: '建立' };
const STATUS_LABEL = {
  pending: '等待中',
  high: '已配對',
  uncertain: '需確認',
  notfound: '找不到',
  manual: '手動指定',
  skipped: '不加入',
  error: '錯誤',
};

const state = {
  source: null,
  target: null,
  playlist: null,
  rows: [],
  filter: 'all',
  stop: false,
  busy: false,
  currentStep: null,
  steps: {
    load: { state: 'idle', done: 0, total: 0 },
    match: { state: 'idle', done: 0, total: 0 },
    create: { state: 'idle', done: 0, total: 0 },
  },
  action: { text: '', since: 0 },
  lastError: null,
};

/* ================= 進度 ================= */

function setStep(name, patch) {
  const s = Object.assign(state.steps[name], patch);
  if (patch.state === 'active') state.currentStep = name;
  const el = document.querySelector(`.step[data-step="${name}"]`);
  el.className = `step is-${s.state}${s.state === 'active' && !s.total ? ' is-indeterminate' : ''}`;
  el.querySelector('.step-count').textContent =
    s.total ? `${s.done} / ${s.total}` : s.state === 'active' ? '…' : s.state === 'done' ? '✓' : '';
  const pct = s.total ? (s.done / s.total) * 100 : s.state === 'done' ? 100 : 0;
  el.querySelector('.bar-fill').style.width = `${pct}%`;
}

function resetSteps(...names) {
  for (const n of names) setStep(n, { state: 'idle', done: 0, total: 0 });
}

function setAction(text) {
  if (!text || text === state.action.text) return;
  state.action = { text, since: Date.now() };
  $('action-text').textContent = text;
  log('info', text);
  tick();
}

function tick() {
  const el = $('action-time');
  if (!state.busy) {
    el.textContent = '';
    el.classList.remove('slow');
    return;
  }
  const sec = Math.floor((Date.now() - state.action.since) / 1000);
  el.textContent = sec >= SLOW_SECONDS ? `已等 ${sec} 秒，仍在等待回應` : `${sec} 秒`;
  el.classList.toggle('slow', sec >= SLOW_SECONDS);
}
setInterval(tick, 500);

/** adapter 的 onProgress 回呼 → 更新目前步驟 */
const progressFor = (step) => (p = {}) => {
  if (p.total != null) setStep(step, { done: p.done ?? 0, total: p.total });
  if (p.message) setAction(p.message);
};

function setBusy(busy) {
  state.busy = busy;
  $('spinner').hidden = !busy;
  for (const id of ['btn-load', 'btn-match', 'btn-create']) $(id).disabled = busy;
  $('target').disabled = busy;
  tick();
}

/* ================= 錯誤與回報 ================= */

function showError(err, step = state.currentStep) {
  state.lastError = { err, step, at: new Date() };
  log('error', `${STEP_NAMES[step] ?? ''}失敗：${err?.message}`, err);
  $('error-msg').textContent = err?.message || String(err);
  $('error-hint').textContent = err?.detail?.hint || '按「複製錯誤回報」把內容貼給開發者';
  $('error').hidden = false;
  if (step) setStep(step, { state: 'error' });
}

function clearError() {
  state.lastError = null;
  $('error').hidden = true;
}

function buildReport() {
  const s = state.steps;
  const fmt = (n) => `${STEP_NAMES[n]} ${s[n].state} ${s[n].done}/${s[n].total}`;
  const lines = [
    '【Playlist Bridge 錯誤回報】',
    `版本：${VERSION}　時間：${new Date().toLocaleString('zh-TW')}`,
    `瀏覽器：${navigator.userAgent}`,
    `來源：${state.source?.url ?? $('src-url').value ?? '-'}（${state.source?.platform ?? '未解析'}）`,
    `目標：${state.target ?? $('target').value}`,
    `進度：${['load', 'match', 'create'].map(fmt).join('｜')}`,
    `目前動作：${state.action.text}（${Math.floor((Date.now() - state.action.since) / 1000)} 秒前開始）`,
  ];
  if (state.lastError) {
    const { err, step, at } = state.lastError;
    lines.push(
      '',
      '■ 錯誤',
      `步驟：${STEP_NAMES[step] ?? step ?? '-'}　時間：${at.toLocaleTimeString('zh-TW')}`,
      `訊息：${err?.message ?? err}`,
    );
    if (err?.detail) lines.push(`細節：${JSON.stringify(err.detail)}`);
    if (err?.stack) lines.push(`堆疊：${err.stack.split('\n').slice(1, 6).map((x) => x.trim()).join(' | ')}`);
  }
  const rowErrors = state.rows
    .map((r, i) => (r.status === 'error' ? `#${i + 1} ${r.src.title} - ${r.src.artists.join(', ')}：${r.error} ${r.errorDetail ? JSON.stringify(r.errorDetail) : ''}` : null))
    .filter(Boolean);
  if (rowErrors.length) lines.push('', '■ 個別歌曲錯誤', ...rowErrors);
  lines.push('', '■ 最近紀錄', ...getEntries().slice(-80).map(formatEntry));
  return redact(lines.join('\n'));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2200);
}

window.addEventListener('error', (e) => showError(e.error || new Error(e.message)));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

/* ================= 執行紀錄面板 ================= */

const logEl = $('log');
onLog((e) => {
  if (e.level === 'debug' && !$('log-panel').open) return;
  logEl.append(formatEntry(e) + '\n');
  while (logEl.childNodes.length > 300) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
});

/* ================= Hero ================= */

function setHero(platform, pl) {
  $('hero').dataset.platform = platform;
  $('hero-eyebrow').textContent = `${PLATFORM_LABELS[platform]} 播放清單`;
  $('hero-title').textContent = pl.name || '未命名清單';
  const totalMs = pl.tracks.reduce((a, t) => a + (t.durationMs || 0), 0);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.round((totalMs % 3_600_000) / 60_000);
  const len = totalMs ? ` · 約 ${h ? `${h} 小時 ` : ''}${m} 分鐘` : '';
  $('hero-meta').innerHTML = '';
  const b = document.createElement('b');
  b.textContent = `${pl.tracks.length} 首歌曲`;
  $('hero-meta').append(b, len);
}

/* ================= 表格 ================= */

const artistsText = (t) => (t.artists || []).join(', ');

function chosenId(row) {
  if (row.selected === '__manual') return parseTrackUrl(row.manual, state.target);
  return row.selected || null;
}

function effectiveStatus(row) {
  if (['pending', 'searching', 'error'].includes(row.status)) return row.status;
  if (row.selected === '__manual') return chosenId(row) ? 'manual' : 'notfound';
  if (!row.selected) return row.userTouched ? 'skipped' : 'notfound';
  if (row.userTouched) return 'high';
  return row.status;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderRow(row, i) {
  const st = effectiveStatus(row);
  const tr = el('tr', st);
  tr.dataset.index = i;

  const tdNum = el('td', 'num', String(i + 1));

  const tdTitle = el('td');
  tdTitle.append(el('div', 't-title', row.src.title), el('div', 't-artist', artistsText(row.src)));

  const tdPick = el('td');
  if (row.status === 'pending' || row.status === 'searching') {
    tdPick.append(el('span', 'dim', '—'));
  } else {
    const wrap = el('div', 'pick');
    const sel = document.createElement('select');
    const opt = (value, text) => {
      const o = el('option', null, text);
      o.value = value;
      return o;
    };
    sel.append(opt('', '不加入'));
    for (const c of row.candidates) {
      const tags = [artistsText(c), formatDuration(c.durationMs), c.kind === 'video' ? 'MV' : '', `${Math.round(c.score * 100)}%`];
      sel.append(opt(c.id, `${c.title} · ${tags.filter(Boolean).join(' · ')}`));
    }
    sel.append(opt('__manual', '貼上連結…'));
    sel.value = row.selected ?? '';
    sel.addEventListener('change', () => {
      row.selected = sel.value;
      row.userTouched = true;
      rerenderRow(i);
    });
    wrap.append(sel);

    const picked = row.candidates.find((c) => c.id === row.selected);
    if (picked?.url) {
      const a = el('a', null, '試聽');
      a.href = picked.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      wrap.append(a);
    }
    tdPick.append(wrap);

    if (row.selected === '__manual') {
      const input = el('input', 'pick-input');
      input.placeholder = state.target === 'spotify' ? 'open.spotify.com/track/…' : 'YouTube 歌曲連結';
      input.value = row.manual || '';
      input.addEventListener('change', () => {
        row.manual = input.value;
        rerenderRow(i);
      });
      tdPick.append(input);
    }
    if (row.error) tdPick.append(el('div', 'row-error', row.error));
  }

  const tdState = el('td');
  if (row.status === 'searching') {
    const mini = el('div', 'mini');
    const bar = el('div', 'bar');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${Math.round((row.stage?.pct ?? 0.05) * 100)}%`;
    bar.append(fill);
    mini.append(el('span', null, row.stage?.label ?? '準備中'), bar);
    tdState.append(mini);
  } else {
    const s = el('div', `state ${st}`);
    s.append(el('span', 'dot'), el('span', null, STATUS_LABEL[st] ?? st));
    tdState.append(s);
  }

  const tdDur = el('td', 'dur', formatDuration(row.src.durationMs));

  tr.append(tdNum, tdTitle, tdPick, tdState, tdDur);
  tr.hidden = !matchesFilter(st);
  return tr;
}

function matchesFilter(st) {
  if (state.filter === 'all') return true;
  if (state.filter === 'uncertain') return st === 'uncertain';
  return ['notfound', 'error', 'skipped'].includes(st);
}

function renderTable() {
  $('rows').replaceChildren(...state.rows.map(renderRow));
  updateCounts();
}

function rerenderRow(i) {
  $('rows').querySelector(`tr[data-index="${i}"]`)?.replaceWith(renderRow(state.rows[i], i));
  updateCounts();
}

function updateCounts() {
  const sts = state.rows.map(effectiveStatus);
  $('c-all').textContent = sts.length;
  $('c-uncertain').textContent = sts.filter((s) => s === 'uncertain').length;
  $('c-notfound').textContent = sts.filter((s) => ['notfound', 'error', 'skipped'].includes(s)).length;
}

/* ================= 步驟 1：讀取 ================= */

async function loadSource() {
  clearError();
  $('done').hidden = true;
  const parsed = parsePlaylistUrl($('src-url').value);
  if (!parsed) {
    showError(new AppError('看不懂這個連結', { hint: '請貼 Spotify / YouTube Music / YouTube 的播放清單連結' }), null);
    return;
  }
  state.source = { ...parsed, url: $('src-url').value.trim() };
  const adapter = ADAPTERS[parsed.platform];

  $('progress').hidden = false;
  resetSteps('load', 'match', 'create');
  setStep('load', { state: 'active' });
  setBusy(true);
  setAction(`連線到 ${adapter.label}`);
  try {
    const pl = await adapter.getPlaylist(parsed.id, progressFor('load'));
    state.playlist = pl;
    state.rows = pl.tracks.map((src) => ({ src, candidates: [], selected: '', status: 'pending' }));
    setStep('load', { state: 'done', done: pl.tracks.length, total: pl.tracks.length });
    setHero(parsed.platform, pl);
    if (!$('pl-name').value) $('pl-name').value = pl.name || '';

    if ($('target').value === parsed.platform || (parsed.platform !== 'spotify' && $('target').value !== 'spotify')) {
      $('target').value = parsed.platform === 'spotify' ? 'ytmusic' : 'spotify';
    }
    $('tracks').hidden = false;
    $('tools').hidden = true;
    $('btn-match').hidden = false;
    $('btn-create').hidden = true;
    state.filter = 'all';
    syncChips();
    renderTable();
    setAction(`找到 ${pl.tracks.length} 首歌`);
    if (parsed.warning || pl.warning) toast(parsed.warning || pl.warning);
  } catch (e) {
    showError(e, 'load');
  } finally {
    setBusy(false);
  }
}

/* ================= 步驟 2：配對 ================= */

async function matchAll() {
  clearError();
  $('done').hidden = true;
  state.target = $('target').value;
  const adapter = ADAPTERS[state.target];
  const total = state.rows.length;

  for (const row of state.rows) {
    Object.assign(row, { status: 'pending', candidates: [], selected: '', userTouched: false, error: undefined, errorDetail: undefined, stage: null });
  }
  renderTable();
  resetSteps('create');
  setStep('match', { state: 'active', done: 0, total });
  state.stop = false;
  setBusy(true);
  $('btn-stop').hidden = false;

  try {
    await adapter.prepare?.(progressFor('match'));
  } catch (e) {
    showError(e, 'match');
    $('btn-stop').hidden = true;
    setBusy(false);
    return;
  }

  let consecutive = 0;
  let i = 0;
  for (; i < total && !state.stop; i++) {
    const row = state.rows[i];
    row.status = 'searching';
    row.stage = { label: '準備中', pct: 0.05 };
    rerenderRow(i);
    $('rows').querySelector(`tr[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    setAction(`第 ${i + 1} / ${total} 首：${row.src.title} - ${artistsText(row.src)}`);

    try {
      row.candidates = await adapter.searchCandidates(row.src, (label, pct) => {
        row.stage = { label, pct };
        rerenderRow(i);
      });
      const best = row.candidates[0];
      row.status = classify(best?.score);
      row.selected = row.status === 'notfound' ? '' : best.id;
      consecutive = 0;
    } catch (e) {
      row.status = 'error';
      row.error = e.message;
      row.errorDetail = e.detail;
      log('error', `#${i + 1} ${row.src.title} 搜尋失敗`, e);
      consecutive++;
    }
    rerenderRow(i);
    setStep('match', { done: i + 1 });

    if (consecutive >= MAX_CONSECUTIVE_ERRORS) {
      const last = state.rows[i];
      showError(new AppError(`連續 ${consecutive} 首都失敗，已自動停止：${last.error}`, last.errorDetail), 'match');
      i++;
      break;
    }
    await sleep(SEARCH_DELAY_MS);
  }

  $('btn-stop').hidden = true;
  setBusy(false);
  if (!state.lastError) setStep('match', { state: 'done', done: i, total });
  const sts = state.rows.map(effectiveStatus);
  const n = (k) => sts.filter((s) => k.includes(s)).length;
  const failed = n(['error']);
  setAction(
    `${state.stop || state.lastError ? '已停止' : '配對完成'}：成功 ${n(['high'])}・需確認 ${n(['uncertain'])}・找不到 ${n(['notfound'])}` +
    (failed ? `・失敗 ${failed}` : '')
  );
  $('btn-create').hidden = false;
  $('tools').hidden = false;
}

/* ================= 步驟 3：建立 ================= */

async function createPlaylist() {
  clearError();
  const adapter = ADAPTERS[state.target];
  const ids = state.rows.map(chosenId).filter(Boolean);
  if (!ids.length) {
    showError(new AppError('沒有選取任何歌曲'), null);
    return;
  }
  const unconfirmed = state.rows.filter((r) => effectiveStatus(r) === 'uncertain').length;
  if (unconfirmed && !confirm(`還有 ${unconfirmed} 首需確認，要直接用預選結果建立嗎？`)) return;

  const name = $('pl-name').value.trim() || state.playlist?.name || '新播放清單';
  setStep('create', { state: 'active', done: 0, total: ids.length });
  setBusy(true);
  try {
    const res = await adapter.createPlaylist(
      name, ids, `由 Playlist Bridge 從 ${state.source.url} 匯入`, progressFor('create')
    );
    setStep('create', { state: 'done', done: ids.length, total: ids.length });
    setAction(`已建立「${name}」`);
    $('done-text').textContent = `已在 ${adapter.label} 建立「${name}」・${ids.length} / ${state.rows.length} 首`;
    $('done-link').href = res.url;
    $('done').hidden = false;
  } catch (e) {
    showError(e, 'create');
  } finally {
    setBusy(false);
  }
}

/* ================= 報告 ================= */

function downloadCsv() {
  const head = ['#', '原始歌名', '原始藝人', '狀態', '配對歌名', '配對藝人', '分數', '連結'];
  const rows = state.rows.map((row, i) => {
    const id = chosenId(row);
    const c = row.candidates.find((x) => x.id === id);
    return [
      i + 1, row.src.title, artistsText(row.src), STATUS_LABEL[effectiveStatus(row)],
      c?.title || (id ? '(手動指定)' : ''), c ? artistsText(c) : '', c ? Math.round(c.score * 100) : '',
      c?.url || (id && row.selected === '__manual' ? row.manual : ''),
    ];
  });
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `playlist-bridge-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copyMissing() {
  const missing = state.rows.filter((r) => !chosenId(r)).map((r) => `${r.src.title} - ${artistsText(r.src)}`);
  await copyText(missing.join('\n'));
  toast(missing.length ? `已複製 ${missing.length} 首` : '全部都有加入');
}

/* ================= 綁定 ================= */

function syncChips() {
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === state.filter));
}

$('btn-load').addEventListener('click', loadSource);
$('btn-match').addEventListener('click', matchAll);
$('btn-stop').addEventListener('click', () => {
  state.stop = true;
  setAction('停止中，等目前這首完成');
});
$('btn-create').addEventListener('click', createPlaylist);
$('btn-csv').addEventListener('click', downloadCsv);
$('btn-copy-missing').addEventListener('click', copyMissing);
$('src-url').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !state.busy) loadSource(); });
for (const btn of document.querySelectorAll('[data-copy-report]')) {
  btn.addEventListener('click', async () => {
    await copyText(buildReport());
    toast('錯誤回報已複製，直接貼上即可');
  });
}
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    syncChips();
    renderTable();
  });
}

const prefill = new URLSearchParams(location.search).get('src');
if (prefill && parsePlaylistUrl(prefill)) $('src-url').value = prefill;
log('info', `Playlist Bridge ${VERSION} 已開啟`);
