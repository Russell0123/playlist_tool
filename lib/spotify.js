// Spotify adapter
//
// 讀取清單：優先用「嵌入播放器」頁面（open.spotify.com/embed/playlist/…），不需登入、不吃 API 限流。
//           超過 100 首或嵌入頁讀不到時，才改用 API。
// 搜尋／建立：借用 open.spotify.com 網頁播放器的 token（background.js 擷取）呼叫 api.spotify.com，需登入。
//
// 進度回呼 onProgress({ done?, total?, message? })；搜尋階段回呼 onStage(label, 0~1)

import { sleep, chunk, findFirst, AppError, fetchWithTimeout } from './util.js';
import { log } from './log.js';
import { rank, buildQuery, THRESHOLD } from './match.js';

const API = 'https://api.spotify.com/v1';
const TOKEN_MAX_AGE = 50 * 60 * 1000;
const REQ_TIMEOUT = 20_000;
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER = 30; // 秒；Spotify 要求等更久就直接回報錯誤

const shortPath = (u) => u.replace(API, '').split('?')[0];

/* ---------------- token ---------------- */

async function readToken() {
  const { spotifyToken } = await chrome.storage.session.get('spotifyToken');
  return spotifyToken;
}

/** 重新整理（或開啟）Spotify 分頁，等網頁播放器發出新請求以取得 token */
async function refreshToken(onWait) {
  onWait?.('等待 Spotify 網頁版提供憑證');
  log('info', 'Spotify：重新整理分頁以取得 token');
  const since = Date.now();
  const [tab] = await chrome.tabs.query({ url: 'https://open.spotify.com/*' });
  if (tab) await chrome.tabs.reload(tab.id);
  else await chrome.tabs.create({ url: 'https://open.spotify.com/', active: false });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const t = await readToken();
    if (t && t.lastSeen >= since) {
      log('info', 'Spotify：已取得 token');
      return t.value;
    }
  }
  throw new AppError('30 秒內拿不到 Spotify 憑證', {
    hint: '請確認 open.spotify.com 分頁能正常開啟，並已登入',
  });
}

async function getToken(onWait) {
  const t = await readToken();
  if (t && Date.now() - t.capturedAt < TOKEN_MAX_AGE) return t.value;
  return refreshToken(onWait);
}

/* ---------------- API ---------------- */

async function spFetch(pathOrUrl, { method = 'GET', body, onWait } = {}, attempt = 0) {
  const token = await getToken(onWait);
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  const label = `Spotify ${method} ${shortPath(url)}`;
  const t0 = Date.now();
  const res = await fetchWithTimeout(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    REQ_TIMEOUT,
    label
  );
  log(res.ok ? 'debug' : 'warn', `${label} → ${res.status}（${Date.now() - t0} ms）`);

  if (res.status === 401 && attempt === 0) {
    await refreshToken(onWait);
    return spFetch(pathOrUrl, { method, body, onWait }, attempt + 1);
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After')) || 5;
    if (wait > MAX_RETRY_AFTER || attempt >= MAX_RETRIES) {
      throw new AppError(`Spotify 限制了請求頻率（要求等待 ${wait} 秒）`, {
        status: 429,
        retryAfter: wait,
        attempt,
        endpoint: shortPath(url),
        hint: '請稍後再試；若持續發生，請先登入 open.spotify.com',
      });
    }
    onWait?.(`Spotify 要求稍等 ${wait} 秒（第 ${attempt + 1} 次重試）`);
    await sleep(wait * 1000);
    return spFetch(pathOrUrl, { method, body, onWait }, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(`Spotify 回應錯誤 ${res.status}`, {
      status: res.status,
      endpoint: `${method} ${shortPath(url)}`,
      body: text.slice(0, 300),
    });
  }
  return res.status === 204 ? null : res.json();
}

/** 依序嘗試多個端點（Spotify 2026 年起把部分 /tracks 端點改名為 /items） */
async function tryPaths(paths, opts) {
  let lastErr;
  for (const p of paths) {
    try {
      return await spFetch(p, opts);
    } catch (e) {
      lastErr = e;
      if (![403, 404, 405].includes(e.detail?.status)) throw e;
      log('warn', `端點不可用，改試下一個：${p}`);
    }
  }
  throw lastErr;
}

const toTrack = (t) => ({
  id: t.uri,
  title: t.name,
  artists: (t.artists || []).map((a) => a.name).filter(Boolean),
  album: t.album?.name,
  durationMs: t.duration_ms,
  kind: 'song',
  url: t.external_urls?.spotify || (t.id ? `https://open.spotify.com/track/${t.id}` : undefined),
});

/* ---------------- 嵌入頁 ---------------- */

/** 解析 open.spotify.com/embed/playlist/{id} 的 HTML（裡面的 __NEXT_DATA__ JSON） */
export function parseEmbedHtml(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const data = JSON.parse(m[1]);
  const entity = findFirst(data, 'entity');
  const list = entity?.trackList ?? findFirst(data, 'trackList');
  if (!Array.isArray(list)) return null;
  const tracks = list
    .filter((t) => t?.title)
    .map((t) => {
      const id = (t.uri || '').split(':').pop();
      return {
        id: t.uri,
        title: t.title,
        artists: (t.subtitle || '')
          .split(/\s*,[\s ]*/)
          .map((s) => s.replace(/ /g, ' ').trim())
          .filter(Boolean),
        durationMs: t.duration,
        kind: 'song',
        url: id ? `https://open.spotify.com/track/${id}` : undefined,
      };
    });
  return { name: entity?.name || entity?.title || '', tracks };
}

async function readViaEmbed(playlistId) {
  const url = `https://open.spotify.com/embed/playlist/${playlistId}`;
  const t0 = Date.now();
  const res = await fetchWithTimeout(url, { credentials: 'omit' }, REQ_TIMEOUT, 'Spotify 嵌入頁');
  log('info', `Spotify 嵌入頁 → ${res.status}（${Date.now() - t0} ms）`);
  if (!res.ok) throw new AppError(`Spotify 嵌入頁回應 ${res.status}`, { status: res.status });
  const parsed = parseEmbedHtml(await res.text());
  if (!parsed?.tracks.length) throw new AppError('Spotify 嵌入頁解析不到歌曲', { hint: '版面可能改了' });
  return parsed;
}

async function readViaApi(playlistId, onProgress) {
  const onWait = (message) => onProgress?.({ message });
  const meta = await spFetch(`/playlists/${playlistId}?fields=name`, { onWait });
  const tracks = [];
  let page = await tryPaths(
    [`/playlists/${playlistId}/items?limit=100`, `/playlists/${playlistId}/tracks?limit=100`],
    { onWait }
  );
  while (page) {
    for (const it of page.items || []) {
      const t = it.item ?? it.track;
      if (!t || t.type === 'episode' || !t.name) continue;
      tracks.push(toTrack(t));
    }
    onProgress?.({ done: tracks.length, total: page.total ?? tracks.length });
    page = page.next ? await spFetch(page.next, { onWait }) : null;
  }
  return { name: meta.name, tracks };
}

/* ---------------- adapter ---------------- */

export const spotify = {
  id: 'spotify',
  label: 'Spotify',

  async prepare(onProgress) {
    await getToken((message) => onProgress?.({ message }));
  },

  async getPlaylist(playlistId, onProgress) {
    onProgress?.({ message: '讀取 Spotify 播放清單' });
    let embed = null;
    try {
      embed = await readViaEmbed(playlistId);
      const n = embed.tracks.length;
      log('info', `嵌入頁讀到 ${n} 首`);
      onProgress?.({ done: n, total: n });
      if (n < 100) return embed;
      onProgress?.({ message: `已讀到 ${n} 首，可能還有更多，改用 API 讀完整清單` });
    } catch (e) {
      log('warn', '嵌入頁讀取失敗，改用 API', e);
      onProgress?.({ message: '改用 Spotify API 讀取' });
    }

    try {
      return await readViaApi(playlistId, onProgress);
    } catch (e) {
      if (!embed) throw e;
      log('warn', 'API 讀取失敗，使用嵌入頁結果', e);
      return { ...embed, warning: `只讀到前 ${embed.tracks.length} 首（${e.message}）` };
    }
  },

  async searchCandidates(track, onStage) {
    const artist = track.artists?.[0] || '';
    const queries = [
      artist ? `track:${track.title} artist:${artist}` : null,
      buildQuery(track),
    ].filter(Boolean);

    let candidates = [];
    for (const [i, q] of queries.entries()) {
      onStage?.(i === 0 ? '搜尋中' : '換關鍵字再搜', 0.2 + i * 0.4);
      const data = await spFetch(`/search?type=track&limit=5&q=${encodeURIComponent(q)}`, {
        onWait: (m) => onStage?.(m, 0.2 + i * 0.4),
      });
      const found = (data.tracks?.items || []).filter(Boolean).map(toTrack);
      candidates = rank(track, [...candidates, ...found.filter((f) => !candidates.some((c) => c.id === f.id))]);
      if (candidates[0]?.score >= THRESHOLD.HIGH) break;
    }
    onStage?.('完成', 1);
    return candidates.slice(0, 5);
  },

  async createPlaylist(name, ids, description, onProgress) {
    const onWait = (message) => onProgress?.({ message });
    onProgress?.({ message: '確認 Spotify 登入狀態', done: 0, total: ids.length });
    let me;
    try {
      me = await spFetch('/me', { onWait });
    } catch (e) {
      if ([401, 403].includes(e.detail?.status)) {
        throw new AppError('Spotify 尚未登入，請先在 open.spotify.com 登入', e.detail);
      }
      throw e;
    }
    onProgress?.({ message: `建立「${name}」` });
    const pl = await tryPaths(
      [`/me/playlists`, `/users/${encodeURIComponent(me.id)}/playlists`],
      { method: 'POST', body: { name, description, public: false }, onWait }
    );
    let done = 0;
    for (const uris of chunk(ids, 100)) {
      await tryPaths(
        [`/playlists/${pl.id}/items`, `/playlists/${pl.id}/tracks`],
        { method: 'POST', body: { uris }, onWait }
      );
      done += uris.length;
      onProgress?.({ done, total: ids.length, message: `加入歌曲 ${done} / ${ids.length}` });
    }
    return { id: pl.id, url: pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}` };
  },
};
