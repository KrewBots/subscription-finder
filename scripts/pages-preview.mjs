// Serves dist/ the way GitHub Pages serves a project site: under a subpath
// (default /subscription-finder/), with only a Content-Type header. No CSP,
// Referrer-Policy or other custom headers, so the page has to protect itself
// with its <meta> tags. "/subscription-finder" redirects to the trailing-slash
// URL and anything outside the subpath is a 404, like Pages.
//
//   npm run build:pages && npm run preview:pages   -> http://localhost:4175/subscription-finder/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

export function createPagesServer({ root = path.join(app, 'dist'), base = '/subscription-finder/' } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { rel = ''; }
    if (rel === base.slice(0, -1)) { res.writeHead(301, { Location: base }).end(); return; }
    if (!rel.startsWith(base)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
    rel = rel.slice(base.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4175;
  createPagesServer().listen(port, '127.0.0.1', () => {
    console.log(`Pages preview at http://localhost:${port}/subscription-finder/  (no custom headers)`);
  });
}
