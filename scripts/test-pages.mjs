// Builds dist/ and runs the e2e suite against it through the Pages-like preview
// server (subpath, no custom headers). Cross-platform way to set E2E_TARGET.
//
//   npm run test:pages
import { spawnSync } from 'node:child_process';

const run = (args, env = {}) => spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status;
const code = run(['scripts/build-pages.mjs']) || run(['--test', '--test-concurrency=1', 'test/e2e/app.e2e.test.js'], { E2E_TARGET: 'pages' });
process.exit(code ?? 1);
