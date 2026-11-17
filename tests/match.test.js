import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, rank, classify, coreTitle, cleanVideoTrack, buildQuery } from '../lib/match.js';
import { parsePlaylistUrl, parseTrackUrl } from '../lib/platforms.js';
import { parseListItem, parsePlaylistTitle, parsePlaylistTotal } from '../lib/ytmusic.js';
import { parseEmbedHtml } from '../lib/spotify.js';
import { redact } from '../lib/log.js';

const src = { title: '告白氣球', artists: ['周杰倫'], durationMs: 215000 };

test('exact song match is high', () => {
  const s = scoreCandidate(src, { title: '告白氣球', artists: ['周杰倫'], durationMs: 216000, kind: 'song' });
  assert.equal(classify(s), 'high');
});

test('same title, artist in other language, same length → still high', () => {
  const s = scoreCandidate(src, { title: '告白氣球', artists: ['Jay Chou'], durationMs: 215000, kind: 'song' });
  assert.equal(classify(s), 'high');
});

test('live / cover versions are penalised below the original', () => {
  const ranked = rank(src, [
    { id: 'live', title: '告白氣球 (Live)', artists: ['周杰倫'], durationMs: 240000, kind: 'song' },
    { id: 'cover', title: '告白氣球 翻唱', artists: ['某某'], durationMs: 214000, kind: 'video' },
    { id: 'orig', title: '告白氣球', artists: ['周杰倫'], durationMs: 215000, kind: 'song' },
  ]);
  assert.equal(ranked[0].id, 'orig');
  assert.notEqual(classify(ranked.find((r) => r.id === 'cover').score), 'high');
});

test('MV title "Artist - Song (Official Video)" still matches', () => {
  const s = scoreCandidate(
    { title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 200000 },
    { title: 'The Weeknd - Blinding Lights (Official Video)', artists: ['TheWeekndVEVO'], durationMs: 262000, kind: 'video' });
  assert.ok(s >= 0.45, `score ${s}`);
});

test('unrelated song is not found', () => {
  const s = scoreCandidate(src, { title: '晴天', artists: ['周杰倫'], durationMs: 269000, kind: 'song' });
  assert.equal(classify(s), 'notfound');
});

test('song with matching "- Remastered" suffix', () => {
  const s = scoreCandidate(
    { title: 'Bohemian Rhapsody - Remastered 2011', artists: ['Queen'], durationMs: 354000 },
    { title: 'Bohemian Rhapsody', artists: ['Queen'], durationMs: 355000, kind: 'song' });
  assert.equal(classify(s), 'high');
});

test('coreTitle / buildQuery', () => {
  assert.equal(coreTitle('Song (feat. X) - Live at Wembley'), 'song');
  assert.equal(buildQuery({ title: 'Hello (Remastered)', artists: ['Adele', 'Y'] }), 'hello Adele');
});

test('cleanVideoTrack splits YouTube video titles', () => {
  assert.deepEqual(
    cleanVideoTrack({ title: '周杰倫 Jay Chou【告白氣球 Love Confession】Official MV', artists: ['杰威爾音樂 JVR Music'] }).title,
    '告白氣球 Love Confession');
  const t = cleanVideoTrack({ title: 'Dua Lipa - Levitating (Official Music Video)', artists: ['Dua Lipa'] });
  assert.equal(t.title, 'Levitating');
  assert.deepEqual(t.artists, ['Dua Lipa']);
});

test('parsePlaylistUrl', () => {
  assert.deepEqual(parsePlaylistUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'), { platform: 'spotify', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.deepEqual(parsePlaylistUrl('https://open.spotify.com/intl-ja/playlist/abc123'), { platform: 'spotify', id: 'abc123' });
  assert.equal(parsePlaylistUrl('https://music.youtube.com/playlist?list=PLabc').platform, 'ytmusic');
  assert.equal(parsePlaylistUrl('https://www.youtube.com/watch?v=x&list=PLabc').platform, 'youtube');
  assert.ok(parsePlaylistUrl('https://www.youtube.com/watch?v=x&list=RDabc').warning);
  assert.equal(parsePlaylistUrl('https://example.com'), null);
  assert.equal(parsePlaylistUrl('not a url'), null);
});

test('parseTrackUrl', () => {
  assert.equal(parseTrackUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=1', 'spotify'), 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(parseTrackUrl('https://youtu.be/dQw4w9WgXcQ', 'ytmusic'), 'dQw4w9WgXcQ');
  assert.equal(parseTrackUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x', 'youtube'), 'dQw4w9WgXcQ');
});

// 依 YouTube Music 實際回應結構縮減的樣本
const artistRun = (text) => ({ text, navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } } });
const searchItem = {
  flexColumns: [
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: '告白氣球', navigationEndpoint: { watchEndpoint: { videoId: 'abcdefghijk', watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' } } } } }] } } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [artistRun('Jay Chou'), { text: ' • ' }, { text: '周杰倫的床邊故事' }, { text: ' • ' }, { text: '3:35' }] } } },
  ],
};
const playlistItem = {
  flexColumns: [
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Song B' }] } } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [artistRun('Artist B')] } } },
  ],
  fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '4:01' }] } } }],
  playlistItemData: { videoId: 'zzzzzzzzzzz' },
};

test('parseListItem: search result', () => {
  assert.deepEqual(parseListItem(searchItem), {
    id: 'abcdefghijk', title: '告白氣球', artists: ['Jay Chou'], durationMs: 215000, kind: 'song',
    url: 'https://music.youtube.com/watch?v=abcdefghijk',
  });
});

test('parseListItem: playlist row with fixed duration column', () => {
  const t = parseListItem(playlistItem);
  assert.equal(t.id, 'zzzzzzzzzzz');
  assert.deepEqual(t.artists, ['Artist B']);
  assert.equal(t.durationMs, 241000);
});

test('parseEmbedHtml (Spotify 嵌入頁)', () => {
  const next = { props: { pageProps: { state: { data: { entity: { name: '海祭金曲派對', trackList: [
    { uri: 'spotify:track:aaa', title: '浪人的眼淚', subtitle: '張震嶽', duration: 245000 },
    { uri: 'spotify:track:bbb', title: '591', subtitle: '鄭宜農, 某人', duration: 338000 },
  ] } } } } } };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`;
  const r = parseEmbedHtml(html);
  assert.equal(r.name, '海祭金曲派對');
  assert.equal(r.tracks.length, 2);
  assert.deepEqual(r.tracks[1].artists, ['鄭宜農', '某人']);
  assert.equal(r.tracks[0].url, 'https://open.spotify.com/track/aaa');
  assert.equal(parseEmbedHtml('<html></html>'), null);
});

test('parsePlaylistTotal', () => {
  assert.equal(parsePlaylistTotal({ musicResponsiveHeaderRenderer: { secondSubtitle: { runs: [{ text: '1,234 首歌曲' }] } } }), 1234);
  assert.equal(parsePlaylistTotal({ musicResponsiveHeaderRenderer: { secondSubtitle: { runs: [{ text: '27 songs' }] } } }), 27);
  assert.equal(parsePlaylistTotal({}), undefined);
});

test('redact hides credentials', () => {
  const s = redact('Authorization: Bearer abc.DEF-123 and SAPISIDHASH 123_abcdef {"accessToken":"xyz"}');
  assert.ok(!s.includes('abc.DEF') && !s.includes('abcdef') && !s.includes('xyz'), s);
});

test('parsePlaylistTitle', () => {
  assert.equal(parsePlaylistTitle({ a: { musicResponsiveHeaderRenderer: { title: { runs: [{ text: 'My List' }] } } } }), 'My List');
});
