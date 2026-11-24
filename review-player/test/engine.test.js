import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ReviewPlayerEngine, parseVTT, timestampToMs, quantize, formatSeconds, FRAME_MS
} from '../src/engine.js';
import {
  MASTER_VTT, NOTES_VTT, MASTER_TRACK_LABEL, NOTES_TRACK_LABEL
} from '../src/data.js';

const here = dirname(fileURLToPath(import.meta.url));
const reviewDir = join(here, '..', '..', 'review');

const makeEngine = () => new ReviewPlayerEngine({
  durationMs: 20000,
  tracks: [
    { label: MASTER_TRACK_LABEL, base: 'master', cues: parseVTT(MASTER_VTT) },
    { label: NOTES_TRACK_LABEL, base: 'slice', cues: parseVTT(NOTES_VTT) }
  ]
});

const masterActive = (e) => e.snapshot().activeByTrack[MASTER_TRACK_LABEL];
const noteActive = (e) => e.snapshot().activeByTrack[NOTES_TRACK_LABEL];

// 按墙钟帧（rAF 约 40ms 一帧）推进到自动停止
const runToStop = (engine, wallFrameMs = FRAME_MS) => {
  engine.play();
  let guard = 0;
  while (engine.playing && guard++ < 100000) engine.advance(wallFrameMs);
  return guard;
};

test('内嵌 VTT 与 review/ 下真实文件逐字一致', () => {
  assert.equal(MASTER_VTT, readFileSync(join(reviewDir, 'master.vtt'), 'utf8'));
  assert.equal(NOTES_VTT, readFileSync(join(reviewDir, 'notes.vtt'), 'utf8'));
});

test('VTT 解析：文本在时间行之前的排法，时间与文本正确', () => {
  const cues = parseVTT(MASTER_VTT);
  assert.deepEqual(cues.map((c) => c.text), ['不要出现', '口型对齐', '第二段', '十一秒半', '出点之后']);
  assert.deepEqual(cues.map((c) => [c.start, c.end]), [
    [7000, 7800], [8000, 9520], [10000, 12000], [11520, 12000], [14200, 15000]
  ]);
  const notes = parseVTT(NOTES_VTT);
  assert.deepEqual(notes.map((c) => [c.start, c.end, c.text]), [
    [0, 1520, '看这一口'], [3000, 3120, '闪一下'], [3520, 4000, '切片三点五']
  ]);
});

test('VTT 解析兼容常规排法（时间行在上、文本在下）', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n常规文本\n第二行\n';
  const cues = parseVTT(vtt);
  assert.equal(cues.length, 1);
  assert.deepEqual([cues[0].start, cues[0].end], [1000, 2000]);
  assert.equal(cues[0].text, '常规文本\n第二行');
  assert.equal(timestampToMs('00:00:11.520'), 11520);
});

test('帧量化与时间格式', () => {
  assert.equal(quantize(8001), 8000);
  assert.equal(quantize(11530), 11520);
  assert.equal(formatSeconds(11520), '11.52');
  assert.equal(FRAME_MS, 40);
});

test('划段 8–14：切片 0 对上成片 08.00，字幕亮灭符合要求', () => {
  const e = makeEngine();
  const s = e.setSegment(8, 14);
  assert.equal(s.sliceDurationMs, 6000);
  assert.equal(s.slicePosMs, 0);
  assert.equal(s.masterPosMs, 8000);
  assert.deepEqual(masterActive(e), ['口型对齐']);
  assert.deepEqual(noteActive(e), ['看这一口']);
  assert.ok(!masterActive(e).includes('不要出现'));
});

test('批注轨按切片时间亮：文件里的 0.00 没被改写成成片 8.00', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  // 批注 cue 本体仍是 0 起算
  const noteCue = e.sliceTrack.cues[0];
  assert.equal(noteCue.start, 0);
  assert.equal(noteCue.end, 1520);
  // 切片 0 亮，而同一时刻成片时间是 8000
  assert.deepEqual(noteActive(e), ['看这一口']);
  assert.equal(e.masterPosMs, 8000);
});

test('半开区间：画面到 09.52 口型对齐灭；12.00 第二段与十一秒半灭', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.seekSlice(1.52); // 成片 9.52
  assert.equal(e.masterPosMs, 9520);
  assert.deepEqual(masterActive(e), []);
  e.seekSlice(4.0); // 成片 12.00
  assert.equal(e.masterPosMs, 12000);
  assert.deepEqual(masterActive(e), []);
  assert.deepEqual(noteActive(e), []); // 切片 4.00：切片三点五 [3.52,4.00) 灭
});

test('切片 3.52：成片 11.52，三条该亮的亮、两条该灭的灭', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  const s = e.seekSlice(3.52);
  assert.equal(s.slicePosMs, 3520);
  assert.equal(s.masterPosMs, 11520);
  assert.deepEqual(masterActive(e), ['第二段', '十一秒半']);
  assert.deepEqual(noteActive(e), ['切片三点五']);
  assert.ok(!masterActive(e).includes('口型对齐'));
  assert.ok(!noteActive(e).includes('看这一口'));
});

test('连续两次跳转以后一次为准：1.00 再 3.52，最终停在 11.52 帧', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.seekSlice(1.0);
  const s = e.seekSlice(3.52); // 上一跳还没落到画面也不影响最终状态
  assert.equal(s.masterPosMs, 11520);
  assert.equal(s.slicePosMs, 3520);
  assert.deepEqual(masterActive(e), ['第二段', '十一秒半']);
  assert.deepEqual(noteActive(e), ['切片三点五']);
  assert.ok(!noteActive(e).includes('看这一口'));
  assert.ok(!masterActive(e).includes('口型对齐'));
  assert.deepEqual(s.recentNotes, []); // 跳转不产生“跳过即亮”，也不写最近亮过
});

test('2 倍速从切片 0 播到出点：停在 14.00 帧，闪一下进过最近亮过，出点之后从不亮', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.setRate(2);
  const frames = runToStop(e);
  assert.ok(frames > 0);
  const s = e.snapshot();
  assert.equal(s.playing, false);
  assert.equal(s.slicePosMs, 6000);
  assert.equal(s.masterPosMs, 14000); // 画面停在烧着 14.00 的那一帧
  assert.deepEqual(masterActive(e), []); // 出点之后(14.20起)不亮
  // 120ms 的“闪一下”在 2 倍速跨帧推进下仍被扫到
  assert.deepEqual(s.recentNotes, ['切片三点五', '闪一下', '看这一口']);
  assert.ok(!s.recentNotes.includes('出点之后'));
  assert.ok(!s.recentNotes.includes('第二段')); // 最近亮过只记录批注轨
});

test('倍速播放过程中出点之后从未亮过', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.setRate(2);
  e.play();
  let guard = 0;
  while (e.playing && guard++ < 100000) {
    e.advance(40);
    assert.ok(!masterActive(e).includes('出点之后'));
    assert.ok(e.masterPosMs <= 14000); // 画面不进入出点后面
  }
});

test('未划段：播放头就是烧着的成片秒，播到 20 秒结尾才停，倍速保持 2×', () => {
  const e = makeEngine();
  e.setRate(2);
  runToStop(e);
  const s = e.snapshot();
  assert.equal(s.playing, false);
  assert.equal(s.masterPosMs, 20000);
  assert.equal(s.rate, 2); // 没划段时设定的倍速保持原样
  assert.equal(s.sliced, false);
  assert.equal(s.slicePosMs, null);
});

test('未划段：10 秒写到整段结尾的字幕 10 秒亮、20 秒灭；零长 cue 亮一秒', () => {
  const e = new ReviewPlayerEngine({
    durationMs: 20000,
    tracks: [
      {
        label: MASTER_TRACK_LABEL, base: 'master',
        cues: [{ start: 10000, end: 20000, text: '写到结尾' }, { start: 10000, end: 10000, text: '零长' }]
      }
    ]
  });
  e.seekMaster(10);
  assert.deepEqual(masterActive(e), ['写到结尾', '零长']);
  e.seekMaster(10.96);
  assert.deepEqual(masterActive(e), ['写到结尾', '零长']); // 零长再亮一秒
  e.seekMaster(11);
  assert.deepEqual(masterActive(e), ['写到结尾']); // 11 秒灭
  e.seekMaster(20);
  assert.deepEqual(masterActive(e), []); // 20 秒灭
});

test('从后往前跳过的字幕不会因为被跳过而亮一下，也不进最近亮过', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.seekSlice(3.52); // 跳过了 闪一下[3.00,3.12]
  assert.deepEqual(e.snapshot().recentNotes, []);
  e.seekSlice(0); // 反向再跳
  assert.deepEqual(e.snapshot().recentNotes, []);
});

test('从切片 3.52 起播：起点之前的 闪一下 不会进最近亮过，到出点正常停', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.seekSlice(3.52);
  e.setRate(2);
  runToStop(e);
  const s = e.snapshot();
  assert.equal(s.masterPosMs, 14000);
  assert.ok(!s.recentNotes.includes('闪一下')); // 3.00–3.12 在起点之前
  assert.deepEqual(s.recentNotes, ['切片三点五']); // 只有起点之后扫过的
});

test('重新划段会清空最近亮过的批注（按“这一段”重新累计）', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.setRate(2);
  runToStop(e);
  assert.ok(e.snapshot().recentNotes.length > 0);
  e.setSegment(8, 14); // 同样的段重新划一次
  assert.deepEqual(e.snapshot().recentNotes, []);
});

test('入点从 8 改到 10：播放头留切片 0，画面 10.00，字幕整体换结果，时长 4 秒', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.seekSlice(3.52);
  const s = e.setSegment(10, 14);
  assert.equal(s.slicePosMs, 0);
  assert.equal(s.masterPosMs, 10000);
  assert.equal(s.sliceDurationMs, 4000);
  assert.deepEqual(masterActive(e), ['第二段']);
  assert.ok(!masterActive(e).includes('口型对齐'));
  assert.deepEqual(noteActive(e), ['看这一口']); // 批注仍按切片 0 亮
});

test('取消划段后回到整支成片，批注轨不再亮，倍速不丢', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.setRate(2);
  e.seekSlice(3.52);
  const s = e.clearSegment();
  assert.equal(s.sliced, false);
  assert.equal(s.masterPosMs, 11520);
  assert.equal(s.rate, 2);
  assert.deepEqual(noteActive(e), []); // 未划段批注轨没有自己的零点
});

test('非法划段被拒绝；跳转夹在切片范围内', () => {
  const e = makeEngine();
  assert.throws(() => e.setSegment(14, 8), RangeError);
  assert.throws(() => e.setSegment(-1, 5), RangeError);
  e.setSegment(8, 14);
  const s = e.seekSlice(99);
  assert.equal(s.slicePosMs, 6000);
  const s0 = e.seekSlice(-3);
  assert.equal(s0.slicePosMs, 0);
});

test('同一快照可同时读到切片播放头与成片播放头', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  e.seekSlice(2.36);
  const s = e.snapshot(7);
  assert.equal(s.seq, 7);
  assert.equal(s.slicePosMs, 2360);
  assert.equal(s.masterPosMs, 10360);
  assert.deepEqual(s.tracks.map((t) => t.label), [MASTER_TRACK_LABEL, NOTES_TRACK_LABEL]);
});

test('到出点后再按播放，从切片 0 重新开始', () => {
  const e = makeEngine();
  e.setSegment(8, 14);
  runToStop(e);
  e.play();
  assert.equal(e.snapshot().playing, true);
  assert.equal(e.snapshot().slicePosMs, 0);
});
