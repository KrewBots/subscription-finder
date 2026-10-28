// Builds the static site GitHub Pages serves: a copy of public/ in dist/.
// Pages can't send custom headers, so the page relies on the <meta> CSP in
// index.html. This script fails if that meta tag is missing or differs from the
// server's CSP, or if any file uses a root-absolute URL ("/x"), which would
// break under a project subpath such as /subscription-finder/.
//
//   npm run build:pages     -> dist/
import { cpSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CSP } from '../server.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(app, 'public');
const out = path.join(app, 'dist');

// Directives a <meta> CSP ignores: browsers only honour these as HTTP headers.
export const HEADER_ONLY = ['frame-ancestors', 'report-uri', 'sandbox'];
export const META_CSP = CSP.split('; ').filter((d) => !HEADER_ONLY.includes(d.split(' ')[0])).join('; ');

function check() {
  const problems = [];
  const html = readFileSync(path.join(src, 'index.html'), 'utf8');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  if (!meta) problems.push('index.html has no <meta http-equiv="Content-Security-Policy">');
  else if (meta[1] !== META_CSP) problems.push(`meta CSP differs from server CSP\n  meta:   ${meta[1]}\n  wanted: ${META_CSP}`);
  for (const file of walk(src).filter((f) => /\.(html|js|css)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    const abs = text.match(/(?:\b(?:src|href)=["']|url\(\s*["']?|fetch\(\s*["'`])\/(?!\/)[^"'`)]*/g);
    if (abs) problems.push(`${path.relative(app, file)}: root-absolute URL ${abs.join(', ')}`);
  }
  return problems;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = check();
  if (problems.length) {
    console.error(`Pages build refused:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
  cpSync(src, out, { recursive: true });
  writeFileSync(path.join(out, '.nojekyll'), ''); // serve files as-is, no Jekyll processing
  console.log(`Built ${walk(out).length} files into dist/ (meta CSP verified, all URLs relative)`);
}
