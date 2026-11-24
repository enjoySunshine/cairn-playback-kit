// 审片播放器：纯逻辑核心，不依赖 DOM，可直接在 Node 中测试。
// 所有内部时间单位为毫秒整数，并量化到帧网格（25fps -> 40ms）。

export const FRAME_MS = 40; // 1000 / 25

export const quantize = (ms) => Math.round(ms / FRAME_MS) * FRAME_MS;

// 秒数（内部毫秒）格式化为两位小数的秒，例如 11520 -> "11.52"
export const formatSeconds = (ms) => (ms / 1000).toFixed(2);

// 00:00:07.000 / 07.000 / 7.000 -> 毫秒
export function timestampToMs(ts) {
  const m = ts.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) {
    const n = Number(ts);
    if (Number.isFinite(n)) return Math.round(n * 1000);
    throw new Error(`无法解析时间戳: ${ts}`);
  }
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

// 解析 WebVTT。按空行切块，块内含 --> 的行是时间行：
// 时间行之前的行是 cue 标识符（本项目素材里恰好与文本同名），
// 时间行之后的行才是 cue 文本；没有后置文本时退而取标识符，保证健壮。
export function parseVTT(text) {
  const blocks = text.replace(/^﻿/, '').split(/\r?\n[ \t]*\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || lines[0] === 'WEBVTT' || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) {
      continue;
    }
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const [startTs, rest] = lines[timeIdx].split('-->');
    const endTs = rest.trim().split(/\s+/)[0]; // 丢掉行内设置
    const id = lines.slice(0, timeIdx).join('\n');
    const body = lines.slice(timeIdx + 1).join('\n') || id;
    if (body) {
      cues.push({ start: timestampToMs(startTs), end: timestampToMs(endTs), text: body });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

const ZERO_LENGTH_HOLD_MS = 1000; // 起点终点相同的 cue 再亮一秒

function isActive(cue, tMs) {
  if (cue.start === cue.end) {
    return tMs >= cue.start && tMs < cue.start + ZERO_LENGTH_HOLD_MS;
  }
  return tMs >= cue.start && tMs < cue.end; // 半开区间：到 end 即灭
}

/**
 * 审片播放器状态机。
 *
 * 两条轨：
 *  - { label: '成片字幕', base: 'master' } 按成片时间亮灭
 *  - { label: '审片批注', base: 'slice'  } 按切片时间亮灭，文件里的时间永不改写
 *
 * 切片时间与成片时间都是播放器自己的播放头，可同时从 snapshot() 读到。
 */
export class ReviewPlayerEngine {
  constructor({ durationMs, tracks }) {
    this.durationMs = quantize(durationMs);
    this.tracks = tracks.map((t) => ({
      label: t.label,
      base: t.base, // 'master' | 'slice'
      cues: t.cues.map((c) => ({ ...c, start: quantize(c.start), end: quantize(c.end) }))
    }));

    this.sliced = false;
    this.inPointMs = 0;
    this.outPointMs = this.durationMs;

    this.slicePosMs = 0; // 切片播放头
    this.masterHeadMs = 0; // 未划段时的成片播放头

    this.playing = false;
    this.rate = 1;

    // 最近亮过的审片批注，最近一次在最前，去重；只记录 slice 轨
    this.recentNotes = [];
  }

  get sliceDurationMs() {
    return this.sliced ? this.outPointMs - this.inPointMs : this.durationMs;
  }

  get masterPosMs() {
    return this.sliced ? this.inPointMs + this.slicePosMs : this.masterHeadMs;
  }

  get masterTrack() {
    return this.tracks.find((t) => t.base === 'master');
  }

  get sliceTrack() {
    return this.tracks.find((t) => t.base === 'slice');
  }

  // ---- 划段 -------------------------------------------------------------

  setSegment(inSec, outSec) {
    const inMs = quantize(Math.round(Number(inSec) * 1000));
    const outMs = quantize(Math.round(Number(outSec) * 1000));
    if (!(inMs >= 0 && outMs <= this.durationMs && inMs < outMs)) {
      throw new RangeError(`入出点非法：${inSec} -> ${outSec}（成片时长 ${this.durationMs / 1000} 秒）`);
    }
    this.sliced = true;
    this.inPointMs = inMs;
    this.outPointMs = outMs;
    this.slicePosMs = 0; // 入点一改，播放头回到新切片 0
    this.playing = false;
    this.recentNotes = []; // 新的一段，最近亮过的批注重新累计
    return this.snapshot();
  }

  clearSegment() {
    const master = this.masterPosMs;
    this.sliced = false;
    this.inPointMs = 0;
    this.outPointMs = this.durationMs;
    this.masterHeadMs = Math.min(master, this.durationMs);
    this.slicePosMs = 0;
    this.playing = false;
    return this.snapshot();
  }

  // ---- 跳转（不产生“跳过即亮”，也不写最近亮过）--------------------------

  seekSlice(sec) {
    if (!this.sliced) throw new RangeError('未划段时没有切片时间');
    let ms = quantize(Math.round(Number(sec) * 1000));
    ms = Math.max(0, Math.min(ms, this.sliceDurationMs));
    this.slicePosMs = ms;
    this.playing = false;
    return this.snapshot();
  }

  seekMaster(sec) {
    let ms = quantize(Math.round(Number(sec) * 1000));
    ms = Math.max(0, Math.min(ms, this.durationMs));
    if (this.sliced) {
      // 划段中任何跳转都夹回划段范围，画面不能停在出点后面
      ms = Math.max(this.inPointMs, Math.min(ms, this.outPointMs));
      this.slicePosMs = ms - this.inPointMs;
    } else {
      this.masterHeadMs = ms;
    }
    this.playing = false;
    return this.snapshot();
  }

  // ---- 播放速率 ---------------------------------------------------------

  setRate(rate) {
    const r = Number(rate);
    if (!(r > 0)) throw new RangeError('倍速必须为正数');
    this.rate = r; // 未划段/划段都保持用户设定
    return this.snapshot();
  }

  play() {
    const atEnd = this.sliced
      ? this.slicePosMs >= this.sliceDurationMs
      : this.masterHeadMs >= this.durationMs;
    if (atEnd) {
      if (this.sliced) this.slicePosMs = 0;
      else this.masterHeadMs = 0;
    }
    this.playing = true;
    return this.snapshot();
  }

  pause() {
    this.playing = false;
    return this.snapshot();
  }

  // ---- 时钟推进（rAF 调用；仅连续播放会写“最近亮过”）--------------------

  advance(dtMs) {
    if (!this.playing || dtMs <= 0) return this.snapshot();
    const delta = Math.round(dtMs * this.rate);

    if (this.sliced) {
      const from = this.slicePosMs;
      let to = from + delta;
      let ended = false;
      if (to >= this.sliceDurationMs) {
        to = this.sliceDurationMs; // 结束帧正好是出点那一帧
        ended = true;
      }
      this.#scanSliceTrack(from, to);
      this.slicePosMs = to;
      if (ended) this.playing = false;
    } else {
      const from = this.masterHeadMs;
      let to = from + delta;
      if (to >= this.durationMs) {
        to = this.durationMs; // 播到结尾才结束
        this.playing = false;
      }
      this.masterHeadMs = to;
    }
    return this.snapshot();
  }

  // 扫过 [from, to) 期间与切片轨有交集的 cue 都记一次，
  // 这样 2 倍速下一帧跨过“闪一下”（120ms）也不会漏。
  #scanSliceTrack(fromMs, toMs) {
    const track = this.sliceTrack;
    if (!track) return;
    for (const cue of track.cues) {
      const end = cue.start === cue.end ? cue.start + ZERO_LENGTH_HOLD_MS : cue.end;
      if (fromMs < end && toMs > cue.start) this.#noteRecent(cue.text);
    }
  }

  #noteRecent(text) {
    this.recentNotes = [text, ...this.recentNotes.filter((t) => t !== text)];
  }

  // ---- 读数 -------------------------------------------------------------

  activeFor(track) {
    const t = track.base === 'slice'
      ? (this.sliced ? this.slicePosMs : null)
      : this.masterPosMs;
    if (t === null) return []; // 未划段：审片批注轨没有自己的零点，不亮
    return track.cues.filter((c) => isActive(c, t)).map((c) => c.text);
  }

  snapshot(seq = 0) {
    const activeByTrack = {};
    for (const track of this.tracks) activeByTrack[track.label] = this.activeFor(track);
    return {
      seq,
      sliced: this.sliced,
      inPointMs: this.inPointMs,
      outPointMs: this.outPointMs,
      durationMs: this.durationMs,
      slicePosMs: this.sliced ? this.slicePosMs : null,
      sliceDurationMs: this.sliced ? this.sliceDurationMs : null,
      masterPosMs: this.masterPosMs,
      playing: this.playing,
      rate: this.rate,
      activeByTrack,
      recentNotes: [...this.recentNotes],
      tracks: this.tracks.map((t) => ({ label: t.label, base: t.base }))
    };
  }
}
