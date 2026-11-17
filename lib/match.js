// 配對評分：比較「來源歌曲」與「搜尋候選」的相似度
//
// Track 結構（所有平台共用）：
//   { id?, title, artists: string[], album?, durationMs?, kind?: 'song'|'video', url? }

export const THRESHOLD = { HIGH: 0.75, LOW: 0.45 };

// 候選有、來源沒有 → 很可能是不同版本，扣分
const VARIANT_LATIN = /\b(live|cover|remix|karaoke|instrumental|inst|acoustic|sped up|slowed|nightcore|8d|reverb|demo|piano ver(sion)?)\b/g;
const VARIANT_CJK = ['伴奏', '翻唱', '現場', '純音樂', '鋼琴版', 'カラオケ', '演唱會', '降速', '加速'];

const NOISE = /\b(official\s*(music\s*)?(video|audio|mv|lyric video|visualizer)?|music\s*video|lyrics?\s*video|lyrics?|m\/v|mv|hd|hq|4k|audio|visualizer)\b/gi;
const NOISE_CJK = /官方(完整版)?|完整版|高音質|動態歌詞|歌詞版?|中字|字幕/g;
const BRACKETS = /[(\[（【「『〔][^)\]）】」』〕]*[)\]）】」』〕]/g;

export function normalize(s) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 只留歌名主體：去括號、去 " - Remastered 2011" 這類後綴、去 MV 等雜訊字 */
export function coreTitle(title) {
  let t = (title || '').replace(BRACKETS, ' ');
  t = t.split(/\s[-–—]\s/)[0];
  return normalize(t.replace(NOISE, ' ').replace(NOISE_CJK, ' '));
}

/** 去括號與雜訊但保留 " - " 兩側（給影片標題「藝人 - 歌名」用） */
export function fullTitle(title) {
  return normalize((title || '').replace(BRACKETS, ' ').replace(NOISE, ' ').replace(NOISE_CJK, ' '));
}

function bigrams(s) {
  const x = s.replace(/\s+/g, '');
  if (x.length < 2) return [x];
  const out = [];
  for (let i = 0; i < x.length - 1; i++) out.push(x.slice(i, i + 2));
  return out;
}

/** Dice 係數（字元 bigram），中英文都適用 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let hit = 0;
  for (const g of B) {
    const c = counts.get(g);
    if (c) {
      hit++;
      counts.set(g, c - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

const contains = (hay, needle) =>
  needle.length >= 2 && hay.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));

function titleScore(src, cand) {
  const s = coreTitle(src.title);
  const c = coreTitle(cand.title);
  let score = similarity(s, c);
  if (score < 1 && (contains(c, s) || contains(s, c))) score = Math.max(score, 0.85);
  // 影片標題常是「藝人 - 歌名 (Official MV)」
  if (score < 0.9 && contains(fullTitle(cand.title), s)) score = Math.max(score, 0.85);
  return score;
}

function artistScore(src, cand) {
  const srcArtists = (src.artists || []).map(normalize).filter(Boolean);
  if (!srcArtists.length) return 0.5;
  const candArtists = normalize((cand.artists || []).join(' '));
  const candTitle = fullTitle(cand.title);
  let best = 0;
  for (const a of srcArtists) {
    if (contains(candArtists, a)) return 1;
    best = Math.max(best, similarity(a, candArtists));
    if (contains(candTitle, a)) best = Math.max(best, 0.8);
  }
  return best;
}

function durationScore(src, cand) {
  if (!src.durationMs || !cand.durationMs) return 0.5;
  const d = Math.abs(src.durationMs - cand.durationMs) / 1000;
  if (d <= 3) return 1;
  if (d <= 8) return 0.8;
  if (d <= 20) return 0.4;
  return 0;
}

function variants(title) {
  const n = normalize(title);
  const set = new Set(n.match(VARIANT_LATIN) || []);
  for (const w of VARIANT_CJK) if (n.includes(w)) set.add(w);
  return set;
}

export function scoreCandidate(src, cand) {
  const t = titleScore(src, cand);
  const a = artistScore(src, cand);
  const d = durationScore(src, cand);
  let score = 0.5 * t + 0.3 * a + 0.2 * d;

  // 歌名幾乎一樣且長度差 ≤ 2 秒：多半是同一首，只是藝人名不同語言（周杰倫 / Jay Chou）
  if (t >= 0.9 && src.durationMs && cand.durationMs &&
      Math.abs(src.durationMs - cand.durationMs) <= 2000) {
    score = Math.max(score, 0.8);
  }

  const srcVar = variants(src.title);
  const extra = [...variants(cand.title)].filter((v) => !srcVar.has(v));
  score -= Math.min(0.6, extra.length * 0.3);

  if (cand.kind === 'video') score -= 0.08; // 偏好正式音訊，MV 是備案

  return Math.max(0, Math.min(1, score));
}

/** 回傳依分數排序、附 score 的候選陣列 */
export function rank(src, candidates) {
  return candidates
    .map((c) => ({ ...c, score: scoreCandidate(src, c) }))
    .sort((x, y) => y.score - x.score);
}

/** 'high' 自動選 / 'uncertain' 預選但標黃 / 'notfound' */
export function classify(score) {
  if (score == null) return 'notfound';
  if (score >= THRESHOLD.HIGH) return 'high';
  if (score >= THRESHOLD.LOW) return 'uncertain';
  return 'notfound';
}

/** 搜尋關鍵字：歌名主體 + 第一位藝人 */
export function buildQuery(track) {
  const title = coreTitle(track.title) || track.title;
  const artist = track.artists?.[0] || '';
  return `${title} ${artist}`.trim();
}

/**
 * YouTube 影片型的來源（非正式音訊）：嘗試從標題拆出藝人與歌名
 *   "Artist - Song (Official Video)"、"周杰倫 Jay Chou【告白氣球】Official MV"
 */
export function cleanVideoTrack(track) {
  const LABELISH = /records|music|entertainment|official|官方|唱片|娛樂|vevo|topic/i;
  const artists = (track.artists || []).map((a) => a.replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').trim());
  let { title } = track;
  let artist = artists[0];

  const bracket = title.match(/^(.+?)\s*【(.+?)】/);
  const dash = title.replace(BRACKETS, ' ').match(/^(.+?)\s[-–—]\s(.+)$/);
  if (bracket) {
    artist = bracket[1].trim();
    title = bracket[2].trim();
  } else if (dash) {
    artist = dash[1].trim();
    title = dash[2].trim();
  }
  title = title.replace(NOISE, ' ').replace(NOISE_CJK, ' ').replace(/\s+/g, ' ').trim() || track.title;

  const out = artist && (!artists[0] || LABELISH.test(artists[0]) || artist !== artists[0])
    ? [artist, ...artists.filter((a) => a !== artist && !LABELISH.test(a))]
    : artists;
  return { ...track, title, artists: out.filter(Boolean) };
}
