// DOM 绑定层。
// 权威归属：ReviewPlayerEngine 是时间轴与字幕的唯一权威；<video> 只是画面/声音输出，
// 同时保留它的原生皮肤、按钮和进度条继续可用。
// 控制方向是单向的：用户操作（自定义控件或原生控件）-> 引擎指令 -> 每帧软同步给 video。
// 播放过程中绝不硬 seek，从根上消除 seeked 反馈环。

import { ReviewPlayerEngine, parseVTT, quantize, formatSeconds, FRAME_MS } from './engine.js';
import {
  MASTER_VTT, NOTES_VTT, MASTER_TRACK_LABEL, NOTES_TRACK_LABEL, MEDIA
} from './data.js';
import { SnapshotChannel } from './sync.js';

export function createEngine() {
  return new ReviewPlayerEngine({
    durationMs: Math.round(MEDIA.durationSec * 1000),
    tracks: [
      { label: MASTER_TRACK_LABEL, base: 'master', cues: parseVTT(MASTER_VTT) },
      { label: NOTES_TRACK_LABEL, base: 'slice', cues: parseVTT(NOTES_VTT) }
    ]
  });
}

const $ = (root, sel) => root.querySelector(sel);

// ---- 五行字 + 切片进度条 ------------------------------------------------------

export function renderSnapshot(root, snap) {
  const row = (name, value) => { $(root, `[data-row="${name}"]`).textContent = value; };
  row(
    'slice-head',
    snap.sliced
      ? `${formatSeconds(snap.slicePosMs)} 秒 / 切片长 ${formatSeconds(snap.sliceDurationMs)} 秒`
      : '（未划段）'
  );
  row('master-head', `${formatSeconds(snap.masterPosMs)} 秒 / 成片长 ${formatSeconds(snap.durationMs)} 秒`);
  row('master-cues', snap.activeByTrack[MASTER_TRACK_LABEL].join('、') || '—');
  row(
    'note-cues',
    snap.sliced ? (snap.activeByTrack[NOTES_TRACK_LABEL].join('、') || '—') : '（未划段，批注轨不亮）'
  );
  row('recent-notes', snap.recentNotes.join('、') || '—');

  const bar = $(root, '#slice-bar');
  if (snap.sliced) {
    bar.disabled = false;
    bar.min = 0;
    bar.max = snap.sliceDurationMs;
    bar.step = FRAME_MS;
    if (!bar.dragging) bar.value = snap.slicePosMs;
    $(root, '#slice-bar-label').textContent =
      `切片进度条（切片时间，0=入点，拖到头=出点）：${formatSeconds(snap.slicePosMs)} / ${formatSeconds(snap.sliceDurationMs)} 秒`;
  } else {
    bar.disabled = true;
    bar.value = 0;
    $(root, '#slice-bar-label').textContent = '切片进度条：未划段，用下方原生播放器的进度条（成片时间）';
  }
}

// 把引擎快照软同步给 video（画面+声音）。
// 播放中绝不硬 seek：引擎与 video 以同样倍速从同一点出发，漂移极小；
// 硬 seek 只用于静止/跳转/到点后的对齐，避免在播放中制造内部补 seek。
function softSyncVideo(video, snap) {
  const targetSec = snap.masterPosMs / 1000;
  const driftMs = Math.abs(video.currentTime - targetSec) * 1000;
  if (!snap.playing && driftMs > FRAME_MS) {
    video.currentTime = targetSec;
  }
  if (video.playbackRate !== snap.rate) video.playbackRate = snap.rate;
  if (snap.playing && video.paused) video.play().catch(() => {});
  else if (!snap.playing && !video.paused) video.pause();
}

// ---- 主控页 ----------------------------------------------------------------

export function initMaster(root) {
  const engine = createEngine();
  const video = $(root, '#video');
  video.src = MEDIA.src;
  video.playbackRate = 1;

  const channel = new SnapshotChannel(() => {}); // 主控页只发不收
  let seq = 0;
  const emit = () => {
    const snap = engine.snapshot(++seq);
    channel.post(snap);
    renderSnapshot(root, snap);
    return snap;
  };

  // rAF 虚拟时钟：墙上时间 dt × 倍速推进引擎，再软同步画面/声音。
  let lastTs = null;
  const loop = (ts) => {
    if (lastTs !== null) {
      const dt = Math.min(ts - lastTs, 100); // 切后台回来不补一大段
      if (engine.playing) {
        const wasPlaying = engine.playing;
        const snap = engine.advance(dt);
        softSyncVideo(video, snap);
        if (wasPlaying && !snap.playing) {
          // 到出点/到结尾：画面与声音一起停在结束帧，不进入后面的成片
          video.pause();
          video.currentTime = snap.masterPosMs / 1000;
        }
        emit();
      }
    }
    lastTs = ts;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // 原生控件 -> 引擎指令。
  // 关键：play()/改 currentTime 之后浏览器会补若干异步 seeking/seeked/waiting，
  // 既可能落在我们给的目标上，也可能落在它内部取整后的邻近帧（实测会偏 ~0.2s）。
  // 因此自身 seek 同时记“目标时间”和“生效窗口”：窗口内到达的 seeked 一律视为回声，
  // 只有窗口之外、确实由用户拖原生进度条产生的 seeked 才回写引擎。
  const SELF_SEEK_WINDOW_MS = 400;
  const selfSeeks = []; // { targetSec, untilMs }
  const beginSelfSeek = (sec) => {
    selfSeeks.push({ targetSec: sec, untilMs: performance.now() + SELF_SEEK_WINDOW_MS });
    video.currentTime = sec;
  };
  const hardSeekToEngine = () => {
    video.pause();
    beginSelfSeek(engine.masterPosMs / 1000);
  };
  const isSelfSeekEcho = (sec) => {
    const now = performance.now();
    for (let i = selfSeeks.length - 1; i >= 0; i--) {
      if (now > selfSeeks[i].untilMs) selfSeeks.splice(i, 1);
    }
    const idx = selfSeeks.findIndex((s) => Math.abs(s.targetSec - sec) < 0.5);
    if (idx !== -1) {
      selfSeeks.splice(idx, 1);
      return true;
    }
    return selfSeeks.length > 0; // 窗口内、邻近位置的内部补 seek 也吸收
  };

  video.addEventListener('play', () => {
    if (engine.playing) return; // 我们自己 play() 的回声
    engine.play();
    emit();
  });
  video.addEventListener('pause', () => {
    if (!engine.playing) return; // 我们自己 pause() 的回声
    engine.pause();
    emit();
  });
  video.addEventListener('seeked', () => {
    if (isSelfSeekEcho(video.currentTime)) return; // 自身/内部跳转回声，不回写引擎
    engine.seekMaster(video.currentTime); // 用户拖原生进度条
    emit();
  });

  // ---- 自定义控制条 ----
  const inInput = $(root, '#in-point');
  const outInput = $(root, '#out-point');
  inInput.value = '8.00';
  outInput.value = '14.00';

  $(root, '#apply-segment').addEventListener('click', () => {
    engine.setSegment(Number(inInput.value), Number(outInput.value));
    hardSeekToEngine();
    emit();
  });
  $(root, '#clear-segment').addEventListener('click', () => {
    engine.clearSegment();
    hardSeekToEngine();
    emit();
  });

  $(root, '#rate').addEventListener('change', (e) => {
    engine.setRate(Number(e.target.value));
    video.playbackRate = engine.rate;
    emit();
  });

  $(root, '#play-pause').addEventListener('click', () => {
    if (engine.playing) {
      engine.pause();
    } else {
      engine.play();
      // 从出点/结尾重播时引擎已回到 0，画面也要对齐到新起点（静止状态的硬 seek）
      if (Math.abs(video.currentTime - engine.masterPosMs / 1000) * 1000 > FRAME_MS) {
        beginSelfSeek(engine.masterPosMs / 1000);
      }
    }
    softSyncVideo(video, engine.snapshot());
    emit();
  });

  const jumpInput = $(root, '#jump-to');
  const doJump = () => {
    if (!engine.sliced) {
      jumpInput.setCustomValidity('请先划段，切片时间才存在');
      jumpInput.reportValidity();
      return;
    }
    jumpInput.setCustomValidity('');
    // 连续两次跳转（哪怕画面还没落到上一跳）也以后一次为准：
    // 引擎权威位置同步更新，video 的最终落点只可能是后一次的目标帧。
    engine.seekSlice(Number(jumpInput.value));
    hardSeekToEngine();
    emit();
  };
  $(root, '#jump-go').addEventListener('click', doJump);
  jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump(); });

  const bar = $(root, '#slice-bar');
  bar.addEventListener('pointerdown', () => { bar.dragging = true; });
  bar.addEventListener('pointerup', () => { bar.dragging = false; });
  bar.addEventListener('input', () => {
    if (!engine.sliced) return;
    engine.seekSlice(Number(bar.value) / 1000);
    hardSeekToEngine();
    emit();
  });

  emit();
  return engine;
}

// ---- 只读镜像页 -------------------------------------------------------------

export function initViewer(root) {
  const video = $(root, '#video');
  video.src = MEDIA.src;
  video.muted = true; // 镜像页不出声，避免两个页面一起放
  $(root, '#controls').setAttribute('aria-disabled', 'true');
  $(root, '#controls').classList.add('viewer-controls');
  $(root, '#role-note').textContent = '只读镜像页：这里的控件已禁用，五行字与主控页一致。';

  const apply = (snap) => {
    renderSnapshot(root, snap);
    softSyncVideo(video, snap); // 只读：只跟随，不回传任何控制指令
  };

  const channel = new SnapshotChannel(apply);

  // 后打开镜像页时先读一次最近快照（localStorage 兜底）
  try {
    const raw = localStorage.getItem('review-player-snapshot-v1');
    if (raw) {
      const snap = JSON.parse(raw);
      renderSnapshot(root, snap);
      video.currentTime = snap.masterPosMs / 1000;
      video.playbackRate = snap.rate;
    }
  } catch { /* 忽略 */ }
  return channel;
}

export { quantize };
