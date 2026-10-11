import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One command starts everything: builds server + host + controller, boots the
 * server, and rebuilds on change. There is only one process to run because
 * there is only one port — nginx proxies /brawl-games/ to 1099 and the server
 * serves both pages from there.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watchDirs = [
  path.join(root, 'packages/protocol/src'),
  path.join(root, 'packages/server/src'),
  path.join(root, 'packages/host'),
  path.join(root, 'packages/controller'),
  // The visual prototypes are copied, not bundled, but the server caches every
  // static file in memory for its lifetime — so without watching these, edits
  // are built into dist and then never served.
  path.join(root, 'packages/prototypes'),
];

let server = null;
let building = false;
let queued = false;

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on('error', reject);
  });

function startServer() {
  stopServer();
  server = spawn(process.execPath, [path.join(root, 'dist/server/index.js')], {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
  });
  server.on('exit', (code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') return; // our own restart
    if (code !== 0) console.error(`[dev] server exited with code ${code}`);
  });
}

function stopServer() {
  if (!server) return;
  const dying = server;
  server = null;
  dying.kill('SIGTERM');
}

async function rebuild(reason) {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  try {
    if (reason) console.log(`\n[dev] ${reason} — rebuilding`);
    await run(process.execPath, [path.join(root, 'tools/build.mjs'), '--dev']);
    startServer();
  } catch (err) {
    console.error(`[dev] build failed: ${err.message}`);
    // Leave the previous server running so phones stay connected while you fix it.
  } finally {
    building = false;
    if (queued) {
      queued = false;
      void rebuild('queued change');
    }
  }
}

// Coalesce editor save storms into one rebuild.
let debounce = null;
function onChange(file) {
  if (file && !/\.(ts|html|css|mjs|js)$/.test(file)) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => void rebuild(`changed ${file ?? 'source'}`), 120);
}

for (const dir of watchDirs) {
  try {
    watch(dir, { recursive: true }, (_event, file) => onChange(file));
  } catch {
    console.warn(`[dev] cannot watch ${dir}`);
  }
}

const shutdown = () => {
  stopServer();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[dev] starting…');
await rebuild(null);
console.log('[dev] watching for changes. Ctrl-C to stop.');
