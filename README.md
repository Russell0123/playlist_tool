# Playlist Bridge

把播放清單在 Spotify、YouTube Music、YouTube 之間互轉的 Chrome 擴充功能。

## 安裝

1. 在這個頁面點綠色的 **Code** → **Download ZIP**
2. 解壓縮，把 `playlist_tool-main` 資料夾放到固定位置（之後別移動或刪掉）
3. Chrome 網址列輸入 `chrome://extensions`
4. 打開右上角 **開發人員模式**
5. 點左上角 **載入未封裝項目**，選 `playlist_tool-main` 資料夾
6. 點工具列的拼圖圖示，把 **Playlist Bridge** 釘選出來

## 使用

1. 在 Chrome 登入要轉入的平台（open.spotify.com 或 music.youtube.com）
2. 點工具列的 Playlist Bridge 圖示
3. 貼上播放清單連結，按 **讀取**
4. 在 **轉到** 選目標平台，需要的話改清單名稱
5. 按 **開始配對**
6. 檢查結果：
   - 綠點：已配對
   - 橘點：需確認，點下拉選單換成正確的歌
   - 紅點：找不到，從下拉選單挑，或選「貼上連結…」貼歌曲網址
7. 按 **建立播放清單**，完成後點 **開啟** 前往新清單

清單建立後是私人的。**下載 CSV** 可存配對結果，**複製未加入** 可複製沒加進去的歌。

## 更新

1. 重新 Download ZIP，解壓後覆蓋原本的資料夾
2. 到 `chrome://extensions`，按 Playlist Bridge 卡片上的 ↻

## 回報問題

出錯時按紅色區塊或頁尾的 **複製錯誤回報**，直接貼給開發者。

## 開發

```bash
npm test
```

```bash
node tests/e2e.mjs
```

`tests/e2e.mjs` 需要 Playwright，用模擬資料跑完整流程。
