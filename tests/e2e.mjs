// 端對端冒煙測試：用模擬的 Spotify / YouTube Music 回應跑完整流程（不連真實網站）
// 執行：node tests/e2e.mjs [截圖路徑]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2];
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1100, height: 900 },
  deviceScaleFactor: shot ? 2 : 1,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const errors = [];

// --- Spotify 模擬 ---
await ctx.route('https://api.spotify.com/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/v1/playlists/PL1') return route.fulfill({ json: { name: '社群歌單 Demo' } });
  if (u.pathname === '/v1/playlists/PL1/items') {
    return route.fulfill({ json: { next: null, items: [
      { item: { uri: 'spotify:track:a', name: '告白氣球', artists: [{ name: '周杰倫' }], duration_ms: 215000 } },
      { item: { uri: 'spotify:track:b', name: 'Blinding Lights', artists: [{ name: 'The Weeknd' }], duration_ms: 200000 } },
      { item: { uri: 'spotify:track:c', name: '超冷門的歌', artists: [{ name: '無名' }], duration_ms: 180000 } },
    ] } });
  }
  return route.fulfill({ status: 404, body: 'not mocked' });
});

// --- YouTube Music 模擬：假頁面 + youtubei API ---
const created = [];
const shelf = (items) => ({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: {
  sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: items } }] } } } }] } } });
const item = (id, title, artist, dur, type) => ({ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId: id },
  flexColumns: [
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title, navigationEndpoint: { watchEndpoint: {
      videoId: id, watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: type } } } } }] } } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: artist }, { text: ' • ' }, { text: dur }] } } },
  ],
} });

await ctx.route('https://music.youtube.com/**', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (!u.pathname.startsWith('/youtubei/')) {
    return route.fulfill({ contentType: 'text/html', body:
      '<html><body>fake ytm<script>window.ytcfg={d:{INNERTUBE_CONTEXT:{client:{clientName:"WEB_REMIX"}},LOGGED_IN:true},get(k){return this.d[k]}}</script></body></html>' });
  }
  const body = req.postDataJSON();
  if (u.pathname.endsWith('/search')) {
    const songs = body.params.includes('IIAW');
    if (body.query.includes('告白')) {
      return route.fulfill({ json: shelf(songs ? [
        item('vid_a______', '告白氣球', 'Jay Chou', '3:35', 'MUSIC_VIDEO_TYPE_ATV'),
        item('vid_live___', '告白氣球 (Live)', 'Jay Chou', '4:10', 'MUSIC_VIDEO_TYPE_ATV'),
      ] : []) });
    }
    if (body.query.includes('blinding')) {
      return route.fulfill({ json: shelf(songs ? [] : [
        item('vid_b______', 'The Weeknd - Blinding Lights (Official Video)', 'The Weeknd', '4:22', 'MUSIC_VIDEO_TYPE_OMV'),
      ]) });
    }
    return route.fulfill({ json: shelf([]) });
  }
  if (u.pathname.endsWith('/playlist/create')) {
    created.push(body);
    return route.fulfill({ json: { playlistId: 'PLnew' } });
  }
  return route.fulfill({ status: 404, body: 'not mocked' });
});

let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await sw.evaluate(() => chrome.storage.session.set({
  spotifyToken: { value: 'fake', capturedAt: Date.now(), lastSeen: Date.now() },
}));

const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('dialog', (d) => d.accept());
await page.goto(`chrome-extension://${extId}/app.html?src=${encodeURIComponent('https://open.spotify.com/playlist/PL1')}`);

await page.click('#btn-load');
await page.waitForSelector('#rows tr');
console.log('loaded:', await page.textContent('#src-info'), '| target =', await page.inputValue('#target'));

// 擴充功能自己開的分頁不吃 Playwright 的模擬，所以先由測試開好（ensureTab 會找到並沿用它）
const ytm = await ctx.newPage();
await ytm.goto('https://music.youtube.com/');
await page.bringToFront();

await page.click('#btn-match');
await page.waitForSelector('#step-create:not([hidden])', { timeout: 30000 });
console.log('status:', await page.textContent('#status'));
for (const tr of await page.$$('#rows tr')) console.log('  ', (await tr.innerText()).replace(/\s+/g, ' '));

await page.bringToFront();
if (shot) await page.screenshot({ path: shot, fullPage: true });

await page.click('#btn-create');
await page.waitForSelector('#create-result a', { timeout: 10000 });
console.log('result:', await page.textContent('#create-result'));
console.log('create body:', JSON.stringify(created[0]));
console.log('errors:', errors.length ? errors : 'none');
await ctx.close();
