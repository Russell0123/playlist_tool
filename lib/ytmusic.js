// YouTube Music adapter（YouTube 也共用這支，見 youtube.js）
// 認證：在 music.youtube.com 分頁裡（MAIN world）呼叫網站自己用的 youtubei 內部 API，
// 自動帶上你已登入的 cookie。沒有官方配額限制，但 YouTube 改版時可能需要修。
//
// 進度回呼 onProgress({ done?, total?, message? })；搜尋階段回呼 onStage(label, 0~1)

import {
  ensureTab, findAll, findFirst, runsText, parseDuration, chunk, AppError, withTimeout,
} from './util.js';
import { log } from './log.js';
import { rank, buildQuery, cleanVideoTrack, THRESHOLD } from './match.js';

const ORIGIN = 'https://music.youtube.com';
const REQ_TIMEOUT = 20_000;

// 搜尋篩選參數（與開源專案 ytmusicapi 相同）
const SEARCH_PARAMS = {
  songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
  videos: 'EgWKAQIQAWoMEA4QChADEAQQCRAF',
};

const TYPE_WORDS = new Set(['Song', 'Video', 'Single', 'EP', 'Album', '歌曲', '影片', '單曲', '專輯']);
const DURATION_RE = /^\d{1,2}(:\d{2}){1,2}$/;
const STATS_RE = /(views|plays|觀看|播放|次)/i;

/* ---------- 以下兩個函式會被注入 music.youtube.com 頁面執行，必須自給自足（不能引用外部變數） ---------- */

function pageReady() {
  return !!window.ytcfg?.get?.('INNERTUBE_CONTEXT');
}

async function innertubeInPage(endpoint, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const cfg = window.ytcfg;
    if (!cfg?.get) return { ok: false, error: 'ytcfg 尚未載入' };

    const cookie = (name) =>
      (document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')) || [])[1];
    const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID');

    const headers = {
      'Content-Type': 'application/json',
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg.get('SESSION_INDEX') ?? 0),
      'X-Youtube-Client-Name': String(cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 67),
      'X-Youtube-Client-Version': String(cfg.get('INNERTUBE_CLIENT_VERSION') ?? ''),
    };
    const pageId = cfg.get('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = pageId; // 品牌帳號

    if (sapisid) {
      const ts = Math.floor(Date.now() / 1000);
      const digest = await crypto.subtle.digest(
        'SHA-1',
        new TextEncoder().encode(`${ts} ${sapisid} ${location.origin}`)
      );
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      headers.Authorization = `SAPISIDHASH ${ts}_${hex}`;
    }

    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await fetch(`/youtubei/v1/${endpoint}${sep}prettyPrint=false`, {
      method: 'POST',
      headers,
      credentials: 'include',
      signal: ctrl.signal,
      body: JSON.stringify({ context: cfg.get('INNERTUBE_CONTEXT'), ...body }),
    });
    const text = await res.text();
    const loggedIn = !!cfg.get('LOGGED_IN');
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300), loggedIn };
    return { ok: true, data: JSON.parse(text), loggedIn };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `${timeoutMs / 1000} 秒沒有回應` : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------------------------- */

const ensureYtmTab = (onWait) =>
  ensureTab({ match: `${ORIGIN}/*`, url: `${ORIGIN}/`, ready: pageReady, onWait });

async function call(endpoint, body = {}, label = endpoint) {
  const tabId = await ensureYtmTab();
  const t0 = Date.now();
  const [{ result } = {}] = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: innertubeInPage,
      args: [endpoint, body, REQ_TIMEOUT],
    }),
    REQ_TIMEOUT + 5_000,
    `YouTube Music ${label}`
  );
  const ep = endpoint.split('?')[0];
  log(result?.ok ? 'debug' : 'warn', `YouTube Music ${ep} → ${result?.ok ? 'OK' : result?.status ?? '失敗'}（${Date.now() - t0} ms）`);
  if (!result?.ok) {
    throw new AppError(`YouTube Music ${label}失敗${result?.status ? `（HTTP ${result.status}）` : ''}`, {
      endpoint: ep,
      status: result?.status,
      error: result?.error ?? 'executeScript 沒有回傳結果',
      loggedIn: result?.loggedIn,
    });
  }
  return result;
}

/** musicResponsiveListItemRenderer → Track（搜尋結果與播放清單項目都是這個結構） */
export function parseListItem(r, { requireId = true } = {}) {
  const cols = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text);
  const title = runsText(cols[0]);
  const videoId = r.playlistItemData?.videoId || findFirst(cols[0], 'videoId') || findFirst(r.overlay, 'videoId');
  if (!title || (requireId && !videoId)) return null;

  const metaRuns = cols.slice(1).flatMap((t) => t?.runs || []);
  const artists = metaRuns
    .filter((run) => {
      const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType;
      return pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL';
    })
    .map((run) => run.text);

  const segments = cols
    .slice(1)
    .map(runsText)
    .join(' • ')
    .split(' • ')
    .map((s) => s.trim())
    .filter(Boolean);
  const fixed = runsText(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text);
  const durStr = [fixed, ...segments].find((s) => DURATION_RE.test(s || ''));
  const fallbackArtist = segments.find((s) => !DURATION_RE.test(s) && !TYPE_WORDS.has(s) && !STATS_RE.test(s));

  const videoType = findFirst(r, 'musicVideoType');
  return {
    id: videoId,
    title,
    artists: [...new Set(artists.length ? artists : fallbackArtist ? [fallbackArtist] : [])],
    durationMs: parseDuration(durStr),
    kind: videoType ? (videoType === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : 'video') : undefined,
    url: videoId ? `${ORIGIN}/watch?v=${videoId}` : undefined,
  };
}

function listItems(node) {
  return findAll(node, 'musicResponsiveListItemRenderer');
}

function getContinuation(node) {
  const cmd = findFirst(node, 'continuationCommand');
  if (cmd?.token) return { token: cmd.token, style: 'new' };
  const old = findFirst(node, 'nextContinuationData');
  if (old?.continuation) return { token: old.continuation, style: 'old' };
  return null;
}

function headerOf(data) {
  return findFirst(data, 'musicResponsiveHeaderRenderer') || findFirst(data, 'musicDetailHeaderRenderer');
}

export function parsePlaylistTitle(data) {
  return runsText(headerOf(data)?.title) || findFirst(data, 'microformatDataRenderer')?.title || '';
}

/** 從標頭的「27 首歌曲」「27 songs」文字抓總數（抓不到回傳 undefined） */
export function parsePlaylistTotal(data) {
  const text = JSON.stringify(headerOf(data) || {});
  const m = text.match(/"text":"([\d,]+)\s*(?:首歌曲|首|songs?|tracks?|部影片|個影片|videos?)"/i);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

function toSourceTrack(t) {
  return t.kind === 'song' ? t : cleanVideoTrack(t);
}

export const ytmusic = {
  id: 'ytmusic',
  label: 'YouTube Music',
  watchUrl: (id) => `${ORIGIN}/watch?v=${id}`,
  playlistUrl: (id) => `${ORIGIN}/playlist?list=${id}`,

  /** 先確認 music.youtube.com 分頁可用，失敗就整批停止，不必每首各等逾時 */
  async prepare(onProgress) {
    onProgress?.({ message: '連線到 YouTube Music' });
    await ensureYtmTab((message) => onProgress?.({ message }));
  },

  async getPlaylist(playlistId, onProgress) {
    await this.prepare(onProgress);
    onProgress?.({ message: '讀取播放清單第 1 頁' });
    const browseId = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
    const first = (await call('browse', { browseId }, '讀取清單')).data;
    const name = parsePlaylistTitle(first);
    let total = parsePlaylistTotal(first);

    // 只取播放清單本體那一區，避免把下方「建議歌曲」也算進來
    const shelf = findFirst(first, 'musicPlaylistShelfRenderer') || first;
    const tracks = listItems(shelf).map((r) => parseListItem(r, { requireId: false })).filter(Boolean);
    onProgress?.({ done: tracks.length, total: total ?? tracks.length });

    let cont = getContinuation(shelf);
    const seen = new Set();
    for (let page = 2; cont && page < 100 && !seen.has(cont.token); page++) {
      seen.add(cont.token);
      onProgress?.({ message: `讀取播放清單第 ${page} 頁` });
      const res = cont.style === 'new'
        ? await call('browse', { continuation: cont.token }, '讀取清單')
        : await call(`browse?ctoken=${cont.token}&continuation=${cont.token}&type=next`, {}, '讀取清單');
      tracks.push(...listItems(res.data).map((r) => parseListItem(r, { requireId: false })).filter(Boolean));
      if (total && tracks.length > total) total = tracks.length;
      onProgress?.({ done: tracks.length, total: total ?? tracks.length });
      cont = getContinuation(res.data);
    }

    if (!tracks.length) {
      throw new AppError('讀不到任何歌曲', { hint: '清單可能是私人的，或 YouTube Music 版面已改變', name });
    }
    return { name, tracks: tracks.map(toSourceTrack) };
  },

  async search(query, kind) {
    const { data } = await call('search', { query, params: SEARCH_PARAMS[kind] }, '搜尋');
    return findAll(data, 'musicShelfRenderer')
      .flatMap((s) => s.contents || [])
      .map((c) => c.musicResponsiveListItemRenderer)
      .filter(Boolean)
      .map((r) => parseListItem(r))
      .filter(Boolean)
      .slice(0, 5)
      .map((c) => ({ ...c, kind: c.kind ?? (kind === 'songs' ? 'song' : 'video') }));
  },

  /** 先搜「歌曲」（正式音訊）；沒有好結果才加搜「影片」（MV 等） */
  async searchCandidates(track, onStage) {
    const q = buildQuery(track);
    onStage?.('搜尋歌曲', 0.25);
    let candidates = rank(track, await this.search(q, 'songs'));
    if (!(candidates[0]?.score >= THRESHOLD.HIGH)) {
      onStage?.('搜尋影片', 0.65);
      const videos = await this.search(q, 'videos');
      const fresh = videos.filter((v) => !candidates.some((c) => c.id === v.id));
      candidates = rank(track, [...candidates, ...fresh]);
    }
    onStage?.('完成', 1);
    return candidates.slice(0, 6).map((c) => ({ ...c, url: this.watchUrl(c.id) }));
  },

  async createPlaylist(name, ids, description, onProgress) {
    await this.prepare(onProgress);
    const [head = [], ...rest] = chunk(ids, 50);
    onProgress?.({ message: `建立「${name}」`, done: 0, total: ids.length });
    const res = await call('playlist/create', {
      title: name,
      description,
      privacyStatus: 'PRIVATE',
      videoIds: head,
    }, '建立清單');
    if (!res.loggedIn) throw new AppError('YouTube 尚未登入，請先在 music.youtube.com 登入');
    const playlistId = res.data.playlistId;
    if (!playlistId) throw new AppError('YouTube 沒有回傳清單 ID', { response: JSON.stringify(res.data).slice(0, 300) });

    let done = head.length;
    onProgress?.({ done, total: ids.length, message: `加入歌曲 ${done} / ${ids.length}` });
    for (const ids50 of rest) {
      await call('browse/edit_playlist', {
        playlistId,
        actions: ids50.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })),
      }, '加入歌曲');
      done += ids50.length;
      onProgress?.({ done, total: ids.length, message: `加入歌曲 ${done} / ${ids.length}` });
    }
    return { id: playlistId, url: this.playlistUrl(playlistId) };
  },
};
