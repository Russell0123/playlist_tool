// Spotify adapter
// 認證：借用 open.spotify.com 網頁播放器的 token（background.js 擷取），不用註冊開發者 App。
// 需求：Chrome 已登入 open.spotify.com（只讀公開清單時不登入也行）。

import { sleep, chunk } from './util.js';
import { rank, buildQuery, THRESHOLD } from './match.js';

const API = 'https://api.spotify.com/v1';
const TOKEN_MAX_AGE = 50 * 60 * 1000;

async function readToken() {
  const { spotifyToken } = await chrome.storage.session.get('spotifyToken');
  return spotifyToken;
}

/** 重新整理（或開啟）Spotify 分頁，等網頁播放器發出新請求以取得 token */
async function refreshToken() {
  const since = Date.now();
  const [tab] = await chrome.tabs.query({ url: 'https://open.spotify.com/*' });
  if (tab) await chrome.tabs.reload(tab.id);
  else await chrome.tabs.create({ url: 'https://open.spotify.com/', active: false });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const t = await readToken();
    if (t && t.lastSeen >= since) return t.value;
  }
  throw new Error('取不到 Spotify 憑證：請在 Chrome 開啟 open.spotify.com 並確認頁面能正常播放後再試');
}

async function getToken() {
  const t = await readToken();
  if (t && Date.now() - t.capturedAt < TOKEN_MAX_AGE) return t.value;
  return refreshToken();
}

async function spFetch(pathOrUrl, { method = 'GET', body, retried = false } = {}) {
  const token = await getToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !retried) {
    await refreshToken();
    return spFetch(pathOrUrl, { method, body, retried: true });
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After') || 2);
    await sleep(Math.min(wait, 30) * 1000);
    return spFetch(pathOrUrl, { method, body, retried });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Spotify API ${res.status}：${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
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
      if (![403, 404, 405].includes(e.status)) throw e;
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

export const spotify = {
  id: 'spotify',
  label: 'Spotify',

  async prepare() {
    await getToken();
  },

  async getPlaylist(playlistId, onProgress) {
    const meta = await spFetch(`/playlists/${playlistId}?fields=name,owner(display_name)`);
    const tracks = [];
    let page = await tryPaths([
      `/playlists/${playlistId}/items?limit=100`,
      `/playlists/${playlistId}/tracks?limit=100`,
    ]);
    while (page) {
      for (const it of page.items || []) {
        const t = it.item ?? it.track;
        if (!t || t.type === 'episode' || !t.name) continue;
        tracks.push(toTrack(t));
      }
      onProgress?.(`已讀取 ${tracks.length} 首…`);
      page = page.next ? await spFetch(page.next) : null;
    }
    return { name: meta.name, tracks };
  },

  async searchCandidates(track) {
    const artist = track.artists?.[0] || '';
    const queries = [
      artist ? `track:${track.title} artist:${artist}` : null,
      buildQuery(track),
    ].filter(Boolean);

    let candidates = [];
    for (const q of queries) {
      const data = await spFetch(`/search?type=track&limit=5&q=${encodeURIComponent(q)}`);
      const found = (data.tracks?.items || []).filter(Boolean).map(toTrack);
      candidates = rank(track, [...candidates, ...found.filter((f) => !candidates.some((c) => c.id === f.id))]);
      if (candidates[0]?.score >= THRESHOLD.HIGH) break;
    }
    return candidates.slice(0, 5);
  },

  async createPlaylist(name, ids, description) {
    const me = await spFetch('/me');
    if (!me?.id) throw new Error('Spotify 尚未登入：請先在 open.spotify.com 登入');
    const body = { name, description, public: false };
    const pl = await tryPaths(
      [`/me/playlists`, `/users/${encodeURIComponent(me.id)}/playlists`],
      { method: 'POST', body }
    );
    for (const uris of chunk(ids, 100)) {
      await tryPaths(
        [`/playlists/${pl.id}/items`, `/playlists/${pl.id}/tracks`],
        { method: 'POST', body: { uris } }
      );
    }
    return { id: pl.id, url: pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}` };
  },
};
