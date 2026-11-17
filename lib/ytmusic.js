// YouTube Music adapter（YouTube 也共用這支，見 youtube.js）
// 認證：在 music.youtube.com 分頁裡（MAIN world）呼叫網站自己用的 youtubei 內部 API，
// 自動帶上你已登入的 cookie。沒有官方配額限制，但 YouTube 改版時可能需要修。

import { ensureTab, findAll, findFirst, runsText, parseDuration, chunk } from './util.js';
import { rank, buildQuery, cleanVideoTrack, THRESHOLD } from './match.js';

const ORIGIN = 'https://music.youtube.com';

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

async function innertubeInPage(endpoint, body) {
  try {
    const cfg = window.ytcfg;
    if (!cfg?.get) return { ok: false, error: 'ytcfg 尚未載入' };

    const cookie = (name) =>
      (document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[-_]/g, '\\$&') + '=([^;]+)')) || [])[1];
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
      body: JSON.stringify({ context: cfg.get('INNERTUBE_CONTEXT'), ...body }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    return { ok: true, data: JSON.parse(text), loggedIn: !!cfg.get('LOGGED_IN') };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/* ---------------------------------------------------------------------------------------------- */

const ensureYtmTab = () => ensureTab({ match: `${ORIGIN}/*`, url: `${ORIGIN}/`, ready: pageReady });

async function call(endpoint, body = {}) {
  const tabId = await ensureYtmTab();
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: innertubeInPage,
    args: [endpoint, body],
  });
  if (!result?.ok) {
    throw new Error(`YouTube Music API 錯誤（${endpoint}）${result?.status ?? ''}：${result?.error ?? '無回應'}`);
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

export function parsePlaylistTitle(data) {
  return (
    runsText(findFirst(data, 'musicResponsiveHeaderRenderer')?.title) ||
    runsText(findFirst(data, 'musicDetailHeaderRenderer')?.title) ||
    findFirst(data, 'microformatDataRenderer')?.title ||
    ''
  );
}

function toSourceTrack(t) {
  return t.kind === 'song' ? t : cleanVideoTrack(t);
}

export const ytmusic = {
  id: 'ytmusic',
  label: 'YouTube Music',
  watchUrl: (id) => `${ORIGIN}/watch?v=${id}`,
  playlistUrl: (id) => `${ORIGIN}/playlist?list=${id}`,

  /** 配對前先確認 music.youtube.com 分頁可用，失敗就整批停止，不必每首各等逾時 */
  async prepare() {
    await ensureYtmTab();
  },

  async getPlaylist(playlistId, onProgress) {
    const browseId = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
    const first = (await call('browse', { browseId })).data;
    const name = parsePlaylistTitle(first);

    // 只取播放清單本體那一區，避免把下方「建議歌曲」也算進來
    const shelf = findFirst(first, 'musicPlaylistShelfRenderer') || first;
    const tracks = listItems(shelf).map((r) => parseListItem(r, { requireId: false })).filter(Boolean);
    onProgress?.(`已讀取 ${tracks.length} 首…`);

    let cont = getContinuation(shelf);
    const seen = new Set();
    for (let page = 0; cont && page < 100 && !seen.has(cont.token); page++) {
      seen.add(cont.token);
      const res = cont.style === 'new'
        ? await call('browse', { continuation: cont.token })
        : await call(`browse?ctoken=${cont.token}&continuation=${cont.token}&type=next`, {});
      tracks.push(...listItems(res.data).map((r) => parseListItem(r, { requireId: false })).filter(Boolean));
      onProgress?.(`已讀取 ${tracks.length} 首…`);
      cont = getContinuation(res.data);
    }

    if (!tracks.length) throw new Error('讀不到任何歌曲：清單可能是私人的，或 YouTube Music 版面已改變');
    return { name, tracks: tracks.map(toSourceTrack) };
  },

  async search(query, kind) {
    const { data } = await call('search', { query, params: SEARCH_PARAMS[kind] });
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
  async searchCandidates(track) {
    const q = buildQuery(track);
    let candidates = rank(track, await this.search(q, 'songs'));
    if (!(candidates[0]?.score >= THRESHOLD.HIGH)) {
      const videos = await this.search(q, 'videos');
      const fresh = videos.filter((v) => !candidates.some((c) => c.id === v.id));
      candidates = rank(track, [...candidates, ...fresh]);
    }
    return candidates.slice(0, 6).map((c) => ({ ...c, url: this.watchUrl(c.id) }));
  },

  async createPlaylist(name, ids, description) {
    const [head = [], ...rest] = chunk(ids, 50);
    const res = await call('playlist/create', {
      title: name,
      description,
      privacyStatus: 'PRIVATE',
      videoIds: head,
    });
    if (!res.loggedIn) throw new Error('YouTube 尚未登入：請先在 music.youtube.com 登入');
    const playlistId = res.data.playlistId;
    if (!playlistId) throw new Error('建立播放清單失敗：YouTube 沒有回傳清單 ID');

    for (const ids50 of rest) {
      await call('browse/edit_playlist', {
        playlistId,
        actions: ids50.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id })),
      });
    }
    return { id: playlistId, url: this.playlistUrl(playlistId) };
  },
};
