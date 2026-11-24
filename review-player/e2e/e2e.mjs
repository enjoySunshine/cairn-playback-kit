// 端到端：无头 Chromium 打开真实页面，加载真实 master.mp4，
// 覆盖需求里的全部验收场景，并截图核对画面烧录时间与跨页面一致性。
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..')); // /workspace
const shotsDir = join(dirname(fileURLToPath(import.meta.url)), 'shots');
await mkdir(shotsDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.mp4': 'video/mp4', '.vtt': 'text/vtt'
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const filePath = normalize(join(root, urlPath === '/' ? '/review-player/player.html' : urlPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  let buf;
  try { buf = await readFile(filePath); } catch { res.writeHead(404); res.end('not found'); return; }
  const type = MIME[extname(filePath)] || 'application/octet-stream';
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m[1] === '' ? 0 : Number(m[1]);
    const end = m[2] === '' ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1);
    if (start >= buf.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` }); res.end(); return;
    }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1
    });
    res.end(buf.subarray(start, end + 1));
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': buf.length });
    res.end(buf);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra: extra ? String(extra) : '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
};

const readRows = async (page) => page.evaluate(() => {
  const get = (k) => document.querySelector(`[data-row="${k}"]`).textContent;
  return {
    slice: get('slice-head'), master: get('master-head'),
    masterCues: get('master-cues'), noteCues: get('note-cues'), recent: get('recent-notes')
  };
});

const waitUntil = async (page, fn, timeout = 8000) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await page.waitForTimeout(50);
  }
  throw new Error('waitUntil 超时，最后值: ' + JSON.stringify(last));
};

const setVal = (page, sel, val) => page.evaluate(([s, v]) => {
  const el = document.querySelector(s);
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [sel, val]);

const click = (page, sel) => page.click(sel);

try {
  // ---------- 主控页 ----------
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/review-player/player.html`);
  await page.waitForSelector('#video');
  await page.evaluate(() => new Promise((res) => {
    const v = document.querySelector('#video');
    if (v.readyState >= 1) res();
    else v.addEventListener('loadeddata', res, { once: true });
  }));

  // 初始未划段
  let rows = await readRows(page);
  check('打开即未划段：切片头显示未划段', rows.slice.includes('未划段'));
  check('打开即未划段：成片头 0.00', rows.master.startsWith('0.00'));

  // 划段 8–14（输入框默认值就是 8/14）
  await click(page, '#apply-segment');
  rows = await readRows(page);
  check('划段后切片 0 / 长 6.00', rows.slice.startsWith('0.00') && rows.slice.includes('6.00'), rows.slice);
  check('成片头 8.00', rows.master.startsWith('8.00'), rows.master);
  check('成片字幕只亮 口型对齐', rows.masterCues === '口型对齐', rows.masterCues);
  check('批注只亮 看这一口', rows.noteCues === '看这一口', rows.noteCues);
  check('不要出现 不亮', rows.masterCues !== '不要出现');
  await page.locator('#video').screenshot({ path: join(shotsDir, '01-slice0-master08.png') });

  // 连跳两次：1.00 然后 3.52
  await setVal(page, '#jump-to', '1.00');
  await click(page, '#jump-go');
  await setVal(page, '#jump-to', '3.52');
  await click(page, '#jump-go');
  await waitUntil(page, async () => (await readRows(page)).master.startsWith('11.52'));
  rows = await readRows(page);
  check('连跳后成片停在 11.52', rows.master.startsWith('11.52'), rows.master);
  check('连跳后切片 3.52', rows.slice.startsWith('3.52'), rows.slice);
  check('亮 第二段+十一秒半', rows.masterCues === '第二段、十一秒半', rows.masterCues);
  check('亮批注 切片三点五', rows.noteCues === '切片三点五', rows.noteCues);
  check('口型对齐/看这一口 都灭', !rows.masterCues.includes('口型对齐') && !rows.noteCues.includes('看这一口'));
  check('跳转不写最近亮过', rows.recent === '—', rows.recent);
  const videoTime = await page.evaluate(() => document.querySelector('#video').currentTime);
  check('video.currentTime 也是 11.52', Math.abs(videoTime - 11.52) < 0.001, String(videoTime));
  await page.locator('#video').screenshot({ path: join(shotsDir, '02-slice3.52-master11.52.png') });

  // 场景 A：从切片 3.52 起播（即跳转后直接播放）。闪一下[3.00,3.12]在起点之前，不应再亮。
  await setVal(page, '#rate', '2');
  await click(page, '#play-pause');
  await waitUntil(page, async () => (await readRows(page)).slice.startsWith('6.00'), 10000);
  await waitUntil(page, async () =>
    (await page.evaluate(() => document.querySelector('#video').paused)) &&
    Math.abs((await page.evaluate(() => document.querySelector('#video').currentTime)) - 14.0) < 0.001
  , 3000);
  rows = await readRows(page);
  check('从3.52起播：停在切片 6.00', rows.slice.startsWith('6.00'), rows.slice);
  check('画面停在成片 14.00', rows.master.startsWith('14.00'), rows.master);
  check('出点之后 不亮', !rows.masterCues.includes('出点之后'), rows.masterCues);
  check('起点之前的 闪一下 不进最近亮过', !rows.recent.includes('闪一下'), rows.recent);
  check('出点之后 不进最近亮过', !rows.recent.includes('出点之后'));
  const endTime = await page.evaluate(() => document.querySelector('#video').currentTime);
  check('声音也停在 14.00 帧', Math.abs(endTime - 14.0) < 0.001, String(endTime));
  await page.locator('#video').screenshot({ path: join(shotsDir, '03-outpoint-master14.png') });

  // 场景 B：重新划段（最近亮过被清空）后回到切片 0，2 倍速整段播，验收“闪一下”会被扫到。
  await setVal(page, '#in-point', '8.00');
  await setVal(page, '#out-point', '14.00');
  await click(page, '#apply-segment');
  check('重新划段后最近亮过清空', (await readRows(page)).recent === '—');
  await setVal(page, '#rate', '2');
  await click(page, '#play-pause');
  await waitUntil(page, async () => (await readRows(page)).slice.startsWith('6.00'), 10000);
  await waitUntil(page, async () =>
    (await page.evaluate(() => document.querySelector('#video').paused)) &&
    Math.abs((await page.evaluate(() => document.querySelector('#video').currentTime)) - 14.0) < 0.001
  , 3000);
  rows = await readRows(page);
  check('整段2x播完停在切片 6.00', rows.slice.startsWith('6.00'), rows.slice);
  check('画面停在成片 14.00（不进后面成片）', rows.master.startsWith('14.00'), rows.master);
  check('最近亮过含 闪一下', rows.recent.includes('闪一下'), rows.recent);
  check('最近亮过顺序 切片三点五>闪一下>看这一口', rows.recent === '切片三点五、闪一下、看这一口', rows.recent);
  check('出点之后 仍不进最近亮过', !rows.recent.includes('出点之后'));

  // 入点改 10，出点仍 14
  await setVal(page, '#in-point', '10.00');
  await click(page, '#apply-segment');
  rows = await readRows(page);
  check('改入点后切片回 0、长 4.00', rows.slice.startsWith('0.00') && rows.slice.includes('4.00'), rows.slice);
  check('画面变成 10.00', rows.master.startsWith('10.00'), rows.master);
  check('第二段 亮、口型对齐 灭', rows.masterCues === '第二段', rows.masterCues);
  check('看这一口 仍按切片 0 亮', rows.noteCues === '看这一口', rows.noteCues);

  // ---------- 镜像页：同一浏览器里再开一个用这套播放器的 html 页面 ----------
  // 同上下文的新标签页：BroadcastChannel 与 localStorage 双通道都生效。
  // （独立浏览器上下文的 localStorage 按浏览器同源安全模型本就不共享，
  //   普通用户“再开一个页面”是同上下文新标签/新窗口，故按此场景验收。）
  const viewer = await ctx.newPage();
  const viewerErrors = [];
  viewer.on('pageerror', (e) => viewerErrors.push(String(e)));
  await viewer.goto(`${base}/review-player/viewer.html`);
  await viewer.waitForSelector('#video');
  await viewer.waitForTimeout(300);
  const vrows0 = await readRows(viewer);
  check('镜像页打开即拿到最近快照：成片 10.00', vrows0.master.startsWith('10.00'), vrows0.master);
  check('镜像页控件禁用', await viewer.evaluate(() => document.querySelector('#controls').classList.contains('viewer-controls')));

  // 主控再做一次跳转，验证两个页面五行字实时一致
  const viewer2 = await ctx.newPage();
  await viewer2.goto(`${base}/review-player/viewer.html`);
  await viewer2.waitForTimeout(200);
  await setVal(page, '#jump-to', '3.52');
  await click(page, '#jump-go');
  await waitUntil(viewer2, async () => (await readRows(viewer2)).master.startsWith('13.52'));
  const vrows = await readRows(viewer2);
  const mrows = await readRows(page);
  check('实时同步：镜像成片头 13.52', vrows.master.startsWith('13.52'), vrows.master);
  check('两页五行字完全一致', JSON.stringify(vrows) === JSON.stringify(mrows),
    `主控=${JSON.stringify(mrows)} 镜像=${JSON.stringify(vrows)}`);

  // ---------- 取消划段：整支 20 秒，4x 播到结尾 ----------
  await click(page, '#clear-segment');
  rows = await readRows(page);
  check('取消划段后批注轨不亮', rows.noteCues.includes('未划段'), rows.noteCues);
  await setVal(page, '#rate', '4');
  await click(page, '#play-pause');
  await waitUntil(page, async () => {
    const paused = await page.evaluate(() => document.querySelector('#video').paused);
    return paused && (await readRows(page)).master.startsWith('20.00');
  }, 12000);
  rows = await readRows(page);
  check('未划段播到 20.00 才停', rows.master.startsWith('20.00'), rows.master);
  check('倍速保持 4x', await page.evaluate(() => document.querySelector('#video').playbackRate) === 4);

  // ---------- 原生皮肤控件仍可用：先回到中段，再测原生播放/暂停、原生进度条 ----------
  await page.evaluate(() => { const v = document.querySelector('#video'); v.currentTime = 5; });
  await page.waitForTimeout(300);

  // 原生播放按钮
  await page.evaluate(() => document.querySelector('#video').play());
  await waitUntil(page, async () => {
    const playing = await page.evaluate(() => !document.querySelector('#video').paused);
    const m1 = (await readRows(page)).master;
    await page.waitForTimeout(200);
    const m2 = (await readRows(page)).master;
    return playing && m1 !== m2;
  }, 5000);
  check('原生播放按钮能驱动引擎走时', true);
  await page.evaluate(() => document.querySelector('#video').pause());
  await page.waitForTimeout(150);
  const afterPause = await readRows(page);
  await page.waitForTimeout(300);
  const afterPause2 = await readRows(page);
  check('原生暂停按钮能停引擎（位置不再变化）', afterPause.master === afterPause2.master,
    `${afterPause.master} -> ${afterPause2.master}`);

  // 原生进度条（直接设 currentTime 模拟用户拖动到成片 11.52）
  await page.evaluate(() => { document.querySelector('#video').currentTime = 11.52; });
  await page.waitForTimeout(300);
  rows = await readRows(page);
  check('原生进度条跳转回写引擎：成片 11.52', rows.master.startsWith('11.52'), rows.master);
  check('原生进度条跳转后成片字幕正确（第二段+十一秒半）',
    rows.masterCues === '第二段、十一秒半', rows.masterCues);

  check('主控页无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));
  check('镜像页无 JS 报错', viewerErrors.length === 0, viewerErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项:', failed.map((f) => f.name).join('；'));
  process.exit(1);
}
console.log('截图目录:', shotsDir);
