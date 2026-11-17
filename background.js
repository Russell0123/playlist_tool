// Service worker：
// 1. 點擴充功能圖示 → 開啟主畫面 app.html（若目前分頁是播放清單，就帶入網址）
// 2. 監聽 open.spotify.com 網頁播放器自己發出的請求，擷取它的 Bearer token，
//    讓我們不用申請 Spotify 開發者金鑰也能呼叫 Spotify API（做法 B）。

chrome.action.onClicked.addListener((tab) => {
  const url = tab?.url || '';
  const isPlaylistPage = /spotify\.com|youtube\.com/.test(url);
  const page = 'app.html' + (isPlaylistPage ? `?src=${encodeURIComponent(url)}` : '');
  chrome.tabs.create({ url: chrome.runtime.getURL(page) });
});

let lastToken = null;
let lastWrite = 0;

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // 只採用 Spotify 網頁播放器本身發出的請求，避免把我們自己的請求誤當成「新 token」
    if (details.initiator !== 'https://open.spotify.com') return;
    const auth = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'authorization');
    if (!auth?.value?.startsWith('Bearer ')) return;

    const value = auth.value.slice(7);
    const now = Date.now();
    if (value === lastToken && now - lastWrite < 15_000) return; // 節流
    const changed = value !== lastToken;
    lastToken = value;
    lastWrite = now;

    chrome.storage.session.get('spotifyToken').then(({ spotifyToken }) => {
      const capturedAt = !changed && spotifyToken?.value === value ? spotifyToken.capturedAt : now;
      chrome.storage.session.set({ spotifyToken: { value, capturedAt, lastSeen: now } });
    });
  },
  { urls: ['https://*.spotify.com/*'] },
  ['requestHeaders', 'extraHeaders']
);
