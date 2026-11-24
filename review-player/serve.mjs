// 零依赖静态服务器：支持 HTTP Range（视频 seek 必需）。
// 用法：node serve.mjs [端口，默认 8000]
// 服务根目录是本目录的上一级（仓库根），这样 /review/master.mp4 与 /review-player/... 都能访问。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = normalize(join(here, '..')); // 仓库根 /workspace
const port = Number(process.argv[2]) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const filePath = normalize(join(root, urlPath === '/' ? '/review-player/player.html' : urlPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  let buf;
  try {
    await stat(filePath);
    buf = await readFile(filePath);
  } catch {
    res.writeHead(404); res.end('not found'); return;
  }
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
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': buf.length });
  res.end(buf);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`审片播放器：http://127.0.0.1:${port}/review-player/player.html`);
  console.log(`只读镜像页：http://127.0.0.1:${port}/review-player/viewer.html`);
});
