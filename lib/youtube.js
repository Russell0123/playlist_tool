// YouTube adapter
// YouTube 和 YouTube Music 共用同一個帳號的播放清單、同一套影片 ID，
// 所以讀取／搜尋／建立都沿用 ytmusic.js（也就順便享有「優先正式音訊、沒有才用 MV」的搜尋邏輯），
// 只把連結換成 youtube.com 的格式。

import { ytmusic } from './ytmusic.js';

const ORIGIN = 'https://www.youtube.com';

export const youtube = {
  ...ytmusic,
  id: 'youtube',
  label: 'YouTube',
  watchUrl: (id) => `${ORIGIN}/watch?v=${id}`,
  playlistUrl: (id) => `${ORIGIN}/playlist?list=${id}`,
};
