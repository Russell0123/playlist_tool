// 解析使用者貼上的播放清單網址／單曲網址

/** @returns {{platform: 'spotify'|'ytmusic'|'youtube', id: string, warning?: string} | null} */
export function parsePlaylistUrl(input) {
  const s = (input || '').trim();

  const spUri = s.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (spUri) return { platform: 'spotify', id: spUri[1] };

  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');

  if (host === 'open.spotify.com') {
    const m = url.pathname.match(/\/playlist\/([A-Za-z0-9]+)/);
    return m ? { platform: 'spotify', id: m[1] } : null;
  }

  if (host === 'music.youtube.com' || host === 'youtube.com' || host === 'youtu.be') {
    const id = url.searchParams.get('list');
    if (!id) return null;
    const platform = host === 'music.youtube.com' ? 'ytmusic' : 'youtube';
    const warning = id.startsWith('RD')
      ? '這是 YouTube 自動產生的合輯（Mix），內容會變動，可能讀不完整'
      : undefined;
    return { platform, id, warning };
  }
  return null;
}

/** 手動貼的單曲連結 → 目標平台用的 id */
export function parseTrackUrl(input, platform) {
  const s = (input || '').trim();
  if (platform === 'spotify') {
    const m = s.match(/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]+)/);
    return m ? `spotify:track:${m[1]}` : null;
  }
  try {
    const url = new URL(s);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
    const v = url.searchParams.get('v');
    if (v) return v;
    const m = url.pathname.match(/\/(?:shorts|embed)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return /^[\w-]{11}$/.test(s) ? s : null;
  }
}

export const PLATFORM_LABELS = {
  spotify: 'Spotify',
  ytmusic: 'YouTube Music',
  youtube: 'YouTube',
};
