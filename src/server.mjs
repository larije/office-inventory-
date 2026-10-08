import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createStore } from './store.mjs';

export const APP_ID = 'office-inventory-v1';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_SAVE_BYTES = 25 * 1024 * 1024;
const BODY_LIMIT = MAX_SAVE_BYTES + 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']],
  ['/inter-latin.woff2', ['inter-latin.woff2', 'font/woff2']],
  ['/logo.png', ['logo.png', 'image/png']],
]);
function fault(message, status = 400) { return Object.assign(new Error(message), { status }); }
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  if (req.headers['x-inventory-request'] !== '1') throw fault('Use the inventory app to make this change.', 403);
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fault('Expected a JSON request.', 415);
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw fault('The selected file is too large. Saves can be up to 25 MB.', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw fault('The selected file is too large. Saves can be up to 25 MB.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fault('The file or request is not valid JSON. Choose a complete Inventory save.'); }
}

export async function startApp({ dataDir = join(ROOT, 'data'), port = 3210, publicDir = join(ROOT, 'public'), writeRuntime = false } = {}) {
  const directory = resolve(dataDir);
  const store = createStore({ dataDir: directory });
  const instanceId = randomBytes(20).toString('hex');
  const installationId = createHash('sha256').update(directory.toLowerCase()).digest('hex');
  const shutdownToken = randomBytes(32).toString('hex');
  const runtimeFile = join(directory, 'runtime.json');
  let address;
  let closing;
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!hosts.includes(req.headers.host)) throw fault('This app is available only on this computer.', 403);
      if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) throw fault('A different website cannot access this inventory.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fault('A different website cannot access this inventory.', 403);
      const pathname = new URL(req.url, `http://${hosts[0]}`).pathname;
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { app: APP_ID, instanceId, installationId });
      }
      if (req.method === 'POST' && pathname === '/internal/shutdown') {
        const candidate = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${shutdownToken}`);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw fault('This launcher does not own the running app.', 403);
        json(res, 200, { stopped: true });
        setImmediate(() => { void close(); });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, store.getState());
      if (req.method === 'GET' && pathname === '/api/backups/download') {
        const snapshot = store.exportSnapshot();
        const text = JSON.stringify(snapshot, null, 2);
        if (Buffer.byteLength(text) > MAX_SAVE_BYTES) throw fault('This inventory exceeds the 25 MB save-file limit. Keep the data folder safe and contact support before moving computers.', 413);
        const filename = `Inventory-${snapshot.savedAt.replace(/[:.]/g, '-')}.inventory`;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` });
        return res.end(text);
      }
      let match;
      if (req.method === 'GET' && (match = pathname.match(/^\/api\/equipment\/([\w-]+)\/history$/))) return json(res, 200, store.getHistory(match[1]));
      if (req.method === 'POST' && pathname === '/api/employees') return json(res, 201, store.saveEmployee(await readJson(req)));
      if (req.method === 'PUT' && (match = pathname.match(/^\/api\/employees\/([\w-]+)$/))) return json(res, 200, store.saveEmployee(await readJson(req), match[1]));
      if (req.method === 'POST' && pathname === '/api/equipment') return json(res, 201, store.saveEquipment(await readJson(req)));
      if (req.method === 'PUT' && (match = pathname.match(/^\/api\/equipment\/([\w-]+)$/))) return json(res, 200, store.saveEquipment(await readJson(req), match[1]));
      if (req.method === 'PUT' && pathname === '/api/settings') return json(res, 200, store.updateSettings(await readJson(req)));
      if (req.method === 'POST' && pathname === '/api/backups/preview') return json(res, 200, store.previewSnapshot(await readJson(req)));
      if (req.method === 'POST' && pathname === '/api/backups/restore') {
        const body = await readJson(req);
        if (!body || body.confirm !== true) throw fault('Confirm that this save will replace the current inventory.');
        return json(res, 200, store.restoreSnapshot(body.snapshot));
      }
      if (req.method === 'GET' && staticFiles.has(pathname)) {
        const [filename, contentType] = staticFiles.get(pathname);
        const content = await readFile(join(publicDir, filename));
        res.writeHead(200, { 'content-type': contentType });
        return res.end(content);
      }
      if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      throw fault('This page or action was not found.', 404);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent && !res.destroyed) json(res, status, { error: status === 500 ? 'The change could not be saved. Check that the inventory folder is writable and try again.' : error.message });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  function listen(requestedPort) {
    return new Promise((done, reject) => {
      const cleanup = () => {
        server.off('error', failed);
        server.off('listening', ready);
      };
      const failed = error => { cleanup(); reject(error); };
      const ready = () => { cleanup(); done(); };
      server.once('error', failed);
      server.once('listening', ready);
      try { server.listen(requestedPort, '127.0.0.1'); }
      catch (error) { failed(error); }
    });
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      store.close();
      if (writeRuntime) {
        try {
          const state = JSON.parse(await readFile(runtimeFile, 'utf8'));
          if (state.instanceId === instanceId) await unlink(runtimeFile);
        } catch (error) { if (error.code !== 'ENOENT') console.error('Could not clear launcher state:', error.message); }
      }
    })();
    return closing;
  }
  try {
    try { await listen(port); }
    catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
      // Let the OS reserve an available port atomically when the preferred one is unavailable.
      await listen(0);
    }
    address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    if (writeRuntime) {
      await mkdir(directory, { recursive: true });
      const temporary = `${runtimeFile}.${instanceId}.tmp`;
      await writeFile(temporary, JSON.stringify({ app: APP_ID, instanceId, installationId, shutdownToken, pid: process.pid, port: address.port }), { mode: 0o600 });
      await rename(temporary, runtimeFile);
    }
    return { url, close, store };
  } catch (error) {
    if (server.listening) await new Promise(done => server.close(done));
    store.close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.OFFICE_INVENTORY_PORT || '3210');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('OFFICE_INVENTORY_PORT must be between 1024 and 65535.');
  startApp({ port, dataDir: process.env.OFFICE_INVENTORY_DATA_DIR || join(ROOT, 'data'), writeRuntime: true }).then(app => {
    console.log(`Office Inventory is ready at ${app.url}`);
    process.once('SIGINT', () => { void app.close(); });
    process.once('SIGTERM', () => { void app.close(); });
  }).catch(error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. No other app was stopped.` : error.message);
    process.exitCode = 1;
  });
}
