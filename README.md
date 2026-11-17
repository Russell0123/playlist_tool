# Playlist Bridge

Spotify ⇄ YouTube Music ⇄ YouTube 播放清單互轉的 Chrome 擴充功能（個人使用，不上架）。

## 安裝

1. 解壓縮到一個固定的資料夾（之後不要搬動或刪除）
2. Chrome 網址列輸入 `chrome://extensions`
3. 打開右上角「開發人員模式」
4. 點「載入未封裝項目」，選這個資料夾（裡面要有 `manifest.json`）
5. 建議把擴充功能釘選到工具列

更新程式碼後，在 `chrome://extensions` 按擴充功能卡片上的 ↻ 重新載入即可。

## 使用

1. 先在同一個 Chrome 登入 **open.spotify.com** 和 **music.youtube.com**
2. 點工具列圖示開啟主畫面（如果當下分頁就是播放清單，網址會自動帶入）
3. 貼上來源清單網址 → 選目標平台 → **讀取來源清單**
4. **開始配對**：綠色＝自動選定、黃色＝預選但請確認、紅色＝找不到（可從下拉選單挑或貼連結）
5. **建立播放清單**（預設為私人），可下載 CSV 報告或複製未加入的歌

執行時擴充功能會在背景開啟 Spotify／YouTube Music 分頁，請不要關掉它們。

## 運作方式

| 平台 | 怎麼連 |
|---|---|
| Spotify | 擷取 open.spotify.com 網頁播放器自己用的 token，再呼叫 `api.spotify.com` |
| YouTube Music | 在 music.youtube.com 分頁內呼叫網站自己的 `youtubei` 內部 API（帶你的登入 cookie） |
| YouTube | 與 YouTube Music 共用帳號清單與影片 ID，沿用同一套程式，只換連結格式 |

沒有使用官方開發者金鑰，所以**沒有配額限制**；相對地，平台改版時可能需要修。

## 配對規則（`lib/match.js`）

- 搜尋字串：歌名主體（去掉括號、Remaster 等）＋第一位藝人
- 分數＝歌名 50%＋藝人 30%＋長度 20%
- 候選多了 Live / Cover / Remix / 伴奏 / 翻唱…等字樣，但來源沒有 → 扣分
- YouTube 系：先搜「歌曲」（正式音訊），分數不夠才加搜「影片」，影片再小扣分 → 盡量不抓 MV
- 歌名幾乎相同且長度差 ≤ 2 秒 → 直接視為高信心（處理「周杰倫 / Jay Chou」這種跨語言藝人名）

## 檔案結構

```
manifest.json      擴充功能設定（MV3）
background.js      點圖示開主畫面；擷取 Spotify token
app.html/css/js    主畫面與流程控制
lib/
  platforms.js     解析清單／單曲網址
  match.js         正規化與評分
  spotify.js       Spotify adapter
  ytmusic.js       YouTube Music adapter
  youtube.js       YouTube adapter（包 ytmusic）
  util.js          共用工具
tests/
  match.test.js    單元測試：npm test
  e2e.mjs          以模擬回應跑完整流程：node tests/e2e.mjs（需 Playwright）
```

每個 adapter 實作相同介面：`prepare()`、`getPlaylist(id)`、`searchCandidates(track)`、`createPlaylist(name, ids, description)`。

## 已知限制

- 尚未對真實網站實測，首次使用可能需要依實際回應調整解析
- 繁簡體不互通（「後來」vs「后来」相似度會偏低 → 多半落在「需確認」）
- 頁面關掉就會遺失配對結果（尚未存檔）
- YouTube 自動產生的合輯（`list=RD…`）可能讀不完整
