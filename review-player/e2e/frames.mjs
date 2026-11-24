// 抓 10.00 帧，并对 08.00 / 10.00 / 11.52 / 14.00 四个位置各截一张图存证。
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = '/workspace';
const shots = join(root, 'review-player/e2e/shots');
await mkdir(shots, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.mp4': 'video/mp4' };
const server = createServer(async (req, res) => {
  const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  let buf;
  try { buf = await readFile(p); } catch { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'app/octet', 'Accept-Ranges': 'bytes' });
  res.end(buf);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${base}/review-player/player.html`);
await page.waitForFunction(() => document.querySelector('#video').readyState >= 2);
await page.click('#clear-segment');
for (const t of [8, 10, 11.52, 14]) {
  await page.evaluate((sec) => { document.querySelector('#video').currentTime = sec; }, t);
  await page.waitForTimeout(250);
  await page.locator('#video').screenshot({ path: join(shots, `frame-${t.toFixed(2)}.png`) });
  const ct = await page.evaluate(() => document.querySelector('#video').currentTime);
  console.log(`seek ${t} -> video.currentTime=${ct.toFixed(3)}`);
}
await browser.close();
server.close();
