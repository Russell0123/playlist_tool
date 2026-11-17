// 端對端測試：用模擬的 Spotify / YouTube Music 回應跑完整流程（不連真實網站）
// 執行：node tests/e2e.mjs [截圖資料夾]
//   情境 A：Spotify（嵌入頁）→ YouTube Music，正常流程
//   情境 B：Spotify 搜尋一直回 429 → 連續失敗自動停止、可複製錯誤回報（不含 token）
//   情境 C：讀取清單失敗 → 顯示錯誤
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = process.argv[2];

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: shotDir ? 2 : 1,
  permissions: ['clipboard-read', 'clipboard-write'],
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

/* ---------- Spotify 模擬 ---------- */
const embedData = { props: { pageProps: { state: { data: { entity: { name: '海祭金曲派對 🎉', trackList: [
  { uri: 'spotify:track:a', title: '告白氣球', subtitle: '周杰倫', duration: 215000 },
  { uri: 'spotify:track:b', title: 'Blinding Lights', subtitle: 'The Weeknd', duration: 200000 },
  { uri: 'spotify:track:c', title: '超冷門的歌', subtitle: '無名', duration: 180000 },
  { uri: 'spotify:track:d', title: '浪人的眼淚', subtitle: '張震嶽', duration: 245000 },
] } } } } } };
await ctx.route('https://open.spotify.com/embed/**', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(embedData)}</script></html>`,
}));
await ctx.route('https://api.spotify.com/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/v1/search') {
    return route.fulfill({ status: 429, headers: { 'Retry-After': '3600' }, body: 'rate limited' });
  }
  return route.fulfill({ status: 404, body: 'not mocked' });
});

/* ---------- YouTube Music 模擬 ---------- */
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
  await new Promise((r) => setTimeout(r, 150)); // 模擬網路延遲
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
    if (body.query.includes('浪人')) {
      return route.fulfill({ json: shelf(songs ? [item('vid_d______', '浪人的眼淚', '張震嶽', '4:05', 'MUSIC_VIDEO_TYPE_ATV')] : []) });
    }
    return route.fulfill({ json: shelf([]) });
  }
  if (u.pathname.endsWith('/browse')) {
    if (body.browseId === 'VLPLbad') return route.fulfill({ status: 500, body: 'internal error' });
    return route.fulfill({ json: {
      header: { musicResponsiveHeaderRenderer: { title: { runs: [{ text: 'YTM 測試清單' }] }, secondSubtitle: { runs: [{ text: '4 首歌曲' }] } } },
      contents: { musicPlaylistShelfRenderer: { contents: [
        item('y1_________', '晴天', '周杰倫', '4:29', 'MUSIC_VIDEO_TYPE_ATV'),
        item('y2_________', '稻香', '周杰倫', '3:43', 'MUSIC_VIDEO_TYPE_ATV'),
        item('y3_________', '七里香', '周杰倫', '4:59', 'MUSIC_VIDEO_TYPE_ATV'),
        item('y4_________', '夜曲', '周杰倫', '3:46', 'MUSIC_VIDEO_TYPE_ATV'),
      ] } },
    } });
  }
  if (u.pathname.endsWith('/playlist/create')) {
    created.push(body);
    return route.fulfill({ json: { playlistId: 'PLnew' } });
  }
  return route.fulfill({ status: 404, body: 'not mocked' });
});

/* ---------- 準備 ---------- */
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await sw.evaluate(() => chrome.storage.session.set({
  spotifyToken: { value: 'SECRET_TOKEN_123', capturedAt: Date.now(), lastSeen: Date.now() },
}));
// 擴充功能自己開的分頁不吃 Playwright 的模擬，所以先由測試開好（ensureTab 會沿用它）
const ytm = await ctx.newPage();
await ytm.goto('https://music.youtube.com/');

const errors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());
const appUrl = (src) => `chrome-extension://${extId}/app.html${src ? `?src=${encodeURIComponent(src)}` : ''}`;
const shot = (name) => shotDir && page.screenshot({ path: path.join(shotDir, name), fullPage: true });

/* ---------- 情境 A ---------- */
console.log('— 情境 A：Spotify → YouTube Music');
await page.goto(appUrl('https://open.spotify.com/playlist/PL1'));
await page.bringToFront();
await page.click('#btn-load');
await page.waitForSelector('#btn-match:not([hidden])');
console.log('  hero:', await page.textContent('#hero-title'), '|', await page.textContent('#hero-meta'));
console.log('  讀取步驟:', await page.textContent('.step[data-step="load"] .step-count'));
assert.equal(await page.textContent('.step[data-step="load"] .step-count'), '4 / 4');

await page.click('#btn-match');
// 配對進行中：抓一次「每首進度」與「步驟進度」
await page.waitForSelector('tr.searching .mini');
console.log('  進行中:', await page.textContent('.step[data-step="match"] .step-count'), '|', await page.textContent('#action-text'));
await shot('progress.png');
await page.waitForSelector('#btn-create:not([hidden])', { timeout: 30000 });
console.log('  配對後:', await page.textContent('#action-text'));
for (const tr of await page.$$('#rows tr')) console.log('    ', (await tr.innerText()).replace(/\s+/g, ' '));
await shot('matched.png');

await page.click('#btn-create');
await page.waitForSelector('#done:not([hidden])', { timeout: 10000 });
console.log('  完成:', await page.textContent('#done-text'), await page.getAttribute('#done-link', 'href'));
assert.deepEqual(created[0].videoIds, ['vid_a______', 'vid_b______', 'vid_d______']);

/* ---------- 情境 B ---------- */
console.log('— 情境 B：YouTube Music → Spotify，搜尋一直被限流');
await page.goto(appUrl('https://music.youtube.com/playlist?list=PLok'));
await page.click('#btn-load');
await page.waitForSelector('#btn-match:not([hidden])');
assert.equal(await page.inputValue('#target'), 'spotify');
const t0 = Date.now();
await page.click('#btn-match');
await page.waitForSelector('#error:not([hidden])', { timeout: 20000 });
console.log(`  ${Date.now() - t0} ms 後停止:`, await page.textContent('#error-msg'));
console.log('  配對步驟:', await page.textContent('.step[data-step="match"] .step-count'));
await page.click('#error [data-copy-report]');
const report = await page.evaluate(() => navigator.clipboard.readText());
assert.ok(report.includes('429'), '回報應包含 429');
assert.ok(!report.includes('SECRET_TOKEN_123'), '回報不應包含 token');
console.log('  錯誤回報前 12 行:\n' + report.split('\n').slice(0, 12).map((l) => '    | ' + l).join('\n'));
await shot('error.png');

/* ---------- 情境 C ---------- */
console.log('— 情境 C：讀取失敗');
await page.goto(appUrl('https://music.youtube.com/playlist?list=PLbad'));
await page.click('#btn-load');
await page.waitForSelector('#error:not([hidden])', { timeout: 20000 });
console.log('  錯誤:', await page.textContent('#error-msg'));

console.log('頁面錯誤:', errors.length ? errors : '無');
await ctx.close();
