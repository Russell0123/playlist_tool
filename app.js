// 主畫面流程：讀取來源 → 逐首配對 → 使用者確認 → 建立清單 → 報告

import { spotify } from './lib/spotify.js';
import { ytmusic } from './lib/ytmusic.js';
import { youtube } from './lib/youtube.js';
import { parsePlaylistUrl, parseTrackUrl, PLATFORM_LABELS } from './lib/platforms.js';
import { classify } from './lib/match.js';
import { sleep, formatDuration } from './lib/util.js';

const ADAPTERS = { spotify, ytmusic, youtube };
const SEARCH_DELAY_MS = 300; // 每首之間稍停，避免被平台限流

const $ = (id) => document.getElementById(id);
const state = {
  source: null,   // { platform, id, url }
  target: null,   // adapter id
  rows: [],       // { src, candidates, selected: id|'' |'__manual', manual, status, error }
  filter: 'all',
  stop: false,
  busy: false,
};

const STATUS_LABEL = {
  pending: '等待中',
  searching: '搜尋中…',
  high: '✓ 已配對',
  uncertain: '⚠ 需確認',
  notfound: '✗ 找不到',
  manual: '✓ 手動指定',
  skipped: '— 不加入',
  error: '✗ 錯誤',
};

/* ---------------- 共用 ---------------- */

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['btn-load', 'btn-match', 'btn-create']) $(id).disabled = busy;
}

const artistsText = (t) => (t.artists || []).join(', ');
const describe = (t) =>
  [artistsText(t), formatDuration(t.durationMs), t.kind === 'video' ? 'MV/影片' : ''].filter(Boolean).join(' · ');

/** 目前這列最後會加入的 id（沒有則 null） */
function chosenId(row) {
  if (row.selected === '__manual') return parseTrackUrl(row.manual, state.target);
  return row.selected || null;
}

function effectiveStatus(row) {
  if (['pending', 'searching', 'error'].includes(row.status)) return row.status;
  if (row.selected === '__manual') return chosenId(row) ? 'manual' : 'notfound';
  if (!row.selected) return row.candidates.length && row.userTouched ? 'skipped' : 'notfound';
  if (row.userTouched) return 'high';
  return row.status;
}

/* ---------------- 表格 ---------------- */

function renderRow(row, i) {
  const tr = document.createElement('tr');
  const st = effectiveStatus(row);
  tr.className = st === 'manual' ? 'high' : st === 'skipped' ? 'notfound' : st;
  tr.dataset.index = i;

  const tdNum = document.createElement('td');
  tdNum.className = 'num';
  tdNum.textContent = i + 1;

  const tdSrc = document.createElement('td');
  tdSrc.innerHTML = `<div class="src-title"></div><div class="src-meta"></div>`;
  tdSrc.children[0].textContent = row.src.title;
  tdSrc.children[1].textContent = describe(row.src);

  const tdPick = document.createElement('td');
  tdPick.className = 'pick';
  if (row.status === 'pending' || row.status === 'searching') {
    tdPick.innerHTML = '<span class="muted">—</span>';
  } else {
    const sel = document.createElement('select');
    const opt = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    };
    sel.append(opt('', '— 不加入 —'));
    for (const c of row.candidates) {
      sel.append(opt(c.id, `${c.title} — ${describe(c)}（${Math.round(c.score * 100)}%）`));
    }
    sel.append(opt('__manual', '手動貼連結…'));
    sel.value = row.selected ?? '';
    sel.addEventListener('change', () => {
      row.selected = sel.value;
      row.userTouched = true;
      rerenderRow(i);
    });
    tdPick.append(sel);

    const picked = row.candidates.find((c) => c.id === row.selected);
    if (picked?.url) {
      const a = document.createElement('a');
      a.href = picked.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = '試聽 ↗';
      tdPick.append(a);
    }
    if (row.selected === '__manual') {
      const input = document.createElement('input');
      input.placeholder = state.target === 'spotify'
        ? '貼上 https://open.spotify.com/track/…'
        : '貼上 YouTube / YouTube Music 歌曲連結';
      input.value = row.manual || '';
      input.addEventListener('change', () => {
        row.manual = input.value;
        rerenderRow(i);
      });
      tdPick.append(input);
    }
    if (row.error) {
      const e = document.createElement('div');
      e.className = 'cand-meta';
      e.textContent = row.error;
      tdPick.append(e);
    }
  }

  const tdState = document.createElement('td');
  tdState.className = 'state';
  tdState.textContent = STATUS_LABEL[st];

  tr.append(tdNum, tdSrc, tdPick, tdState);
  tr.hidden = !matchesFilter(st);
  return tr;
}

function matchesFilter(st) {
  if (state.filter === 'all') return true;
  if (state.filter === 'uncertain') return st === 'uncertain';
  return ['notfound', 'error', 'skipped'].includes(st);
}

function renderTable() {
  const tbody = $('rows');
  tbody.replaceChildren(...state.rows.map(renderRow));
  updateCounts();
}

function rerenderRow(i) {
  const old = $('rows').querySelector(`tr[data-index="${i}"]`);
  old?.replaceWith(renderRow(state.rows[i], i));
  updateCounts();
}

function updateCounts() {
  const sts = state.rows.map(effectiveStatus);
  $('c-all').textContent = sts.length;
  $('c-uncertain').textContent = sts.filter((s) => s === 'uncertain').length;
  $('c-notfound').textContent = sts.filter((s) => ['notfound', 'error', 'skipped'].includes(s)).length;
}

/* ---------------- 步驟 1：讀取 ---------------- */

async function loadSource() {
  const parsed = parsePlaylistUrl($('src-url').value);
  if (!parsed) {
    setStatus('看不懂這個網址：請貼 Spotify / YouTube Music / YouTube 的「播放清單」連結', true);
    return;
  }
  state.source = { ...parsed, url: $('src-url').value.trim() };
  setBusy(true);
  setStatus(`正在從 ${PLATFORM_LABELS[parsed.platform]} 讀取清單…`);
  try {
    const pl = await ADAPTERS[parsed.platform].getPlaylist(parsed.id, (m) => setStatus(m));
    state.rows = pl.tracks.map((src) => ({ src, candidates: [], selected: '', status: 'pending' }));
    if (!$('pl-name').value) $('pl-name').value = pl.name || '匯入的播放清單';
    $('src-info').textContent = `${PLATFORM_LABELS[parsed.platform]}・${pl.name || '(無標題)'}・${pl.tracks.length} 首`;

    // 目標預設選「另一個平台」
    if ($('target').value === parsed.platform || (parsed.platform !== 'spotify' && $('target').value !== 'spotify')) {
      $('target').value = parsed.platform === 'spotify' ? 'ytmusic' : 'spotify';
    }
    $('step-match').hidden = false;
    $('step-create').hidden = true;
    renderTable();
    setStatus(parsed.warning || `讀取完成，共 ${pl.tracks.length} 首。確認目標平台後按「開始配對」。`);
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  } finally {
    setBusy(false);
  }
}

/* ---------------- 步驟 2：配對 ---------------- */

async function matchAll() {
  state.target = $('target').value;
  const adapter = ADAPTERS[state.target];
  if (state.source.platform === state.target) {
    setStatus('來源和目標是同一個平台，這樣會複製一份清單（可以，但確定嗎？）');
  }
  state.stop = false;
  setBusy(true);
  try {
    setStatus(`連線到 ${adapter.label}…`);
    await adapter.prepare?.();
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
    setBusy(false);
    return;
  }
  $('btn-stop').hidden = false;
  $('progress').hidden = false;
  $('progress').max = state.rows.length;

  for (const row of state.rows) {
    row.status = 'pending';
    row.candidates = [];
    row.selected = '';
    row.userTouched = false;
    row.error = undefined;
  }
  renderTable();

  for (let i = 0; i < state.rows.length && !state.stop; i++) {
    const row = state.rows[i];
    row.status = 'searching';
    rerenderRow(i);
    setStatus(`配對中 ${i + 1} / ${state.rows.length}：${row.src.title}`);
    try {
      row.candidates = await adapter.searchCandidates(row.src);
      const best = row.candidates[0];
      row.status = classify(best?.score);
      row.selected = row.status === 'notfound' ? '' : best.id;
    } catch (e) {
      console.error(e);
      row.status = 'error';
      row.error = e.message;
    }
    rerenderRow(i);
    $('progress').value = i + 1;
    await sleep(SEARCH_DELAY_MS);
  }

  $('btn-stop').hidden = true;
  setBusy(false);
  $('step-create').hidden = false;
  const sts = state.rows.map(effectiveStatus);
  setStatus(
    `${state.stop ? '已停止。' : '配對完成。'}` +
    `自動配對 ${sts.filter((s) => s === 'high').length}、需確認 ${sts.filter((s) => s === 'uncertain').length}、` +
    `找不到 ${sts.filter((s) => s === 'notfound' || s === 'error').length}`
  );
}

/* ---------------- 步驟 3：建立 & 報告 ---------------- */

async function createPlaylist() {
  const adapter = ADAPTERS[state.target];
  const ids = state.rows.map(chosenId).filter(Boolean);
  if (!ids.length) {
    setStatus('沒有任何歌曲被選取', true);
    return;
  }
  const unconfirmed = state.rows.filter((r) => effectiveStatus(r) === 'uncertain').length;
  if (unconfirmed && !confirm(`還有 ${unconfirmed} 首「需確認」的歌會以預選結果加入，要繼續嗎？`)) return;

  const name = $('pl-name').value.trim() || '匯入的播放清單';
  setBusy(true);
  setStatus(`正在 ${adapter.label} 建立「${name}」（${ids.length} 首）…`);
  try {
    const res = await adapter.createPlaylist(name, ids, `由 Playlist Bridge 從 ${state.source.url} 匯入`);
    const out = $('create-result');
    out.textContent = `完成！已加入 ${ids.length} / ${state.rows.length} 首：`;
    const a = document.createElement('a');
    a.href = res.url;
    a.target = '_blank';
    a.textContent = res.url;
    out.append(a);
    setStatus('');
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  } finally {
    setBusy(false);
  }
}

function reportRows() {
  return state.rows.map((row, i) => {
    const id = chosenId(row);
    const c = row.candidates.find((x) => x.id === id);
    return {
      no: i + 1,
      title: row.src.title,
      artist: artistsText(row.src),
      status: STATUS_LABEL[effectiveStatus(row)],
      matchTitle: c?.title || (id ? '(手動指定)' : ''),
      matchArtist: c ? artistsText(c) : '',
      score: c ? Math.round(c.score * 100) : '',
      link: c?.url || (id && row.selected === '__manual' ? row.manual : ''),
    };
  });
}

function downloadCsv() {
  const head = ['#', '原始歌名', '原始藝人', '狀態', '配對歌名', '配對藝人', '分數', '連結'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head, ...reportRows().map((r) => Object.values(r))].map((r) => r.map(esc).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `playlist-bridge-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copyMissing() {
  const missing = state.rows.filter((r) => !chosenId(r)).map((r) => `${r.src.title} - ${artistsText(r.src)}`);
  await navigator.clipboard.writeText(missing.join('\n'));
  setStatus(missing.length ? `已複製 ${missing.length} 首未加入的歌` : '全部都有加入 🎉');
}

/* ---------------- 綁定 ---------------- */

$('btn-load').addEventListener('click', loadSource);
$('btn-match').addEventListener('click', matchAll);
$('btn-stop').addEventListener('click', () => { state.stop = true; });
$('btn-create').addEventListener('click', createPlaylist);
$('btn-csv').addEventListener('click', downloadCsv);
$('btn-copy-missing').addEventListener('click', copyMissing);
$('src-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSource(); });
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderTable();
  });
}

const prefill = new URLSearchParams(location.search).get('src');
if (prefill && parsePlaylistUrl(prefill)) $('src-url').value = prefill;
