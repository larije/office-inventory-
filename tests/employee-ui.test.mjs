import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../src/server.mjs';

test('served employee screen exposes division editing, filtering and the directory column', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-employee-ui-'));
  const app = await startApp({ dataDir, port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const response = await fetch(app.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  const form = html.match(/<form\b[^>]*id="employee-form"[^>]*>([\s\S]*?)<\/form>/)?.[1];
  assert.ok(form, 'Employee form must be available.');
  const choices = form.match(/<select\b[^>]*name="division"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(choices, 'Employees must be able to choose a division.');
  const values = [...choices.matchAll(/<option\b[^>]*value="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(values.sort(), ['', 'CRADD', 'LTOD', 'LTSAD', 'REVDIV']);
  const directory = html.match(/<section\b[^>]*id="employees-view"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.match(directory, /<select\b[^>]*id="employee-division-filter"/);
  assert.match(directory, /<th\b[^>]*>Division<\/th>/);
  assert.match(directory, /<th\b[^>]*>Employee ID<\/th>/);
});

test('theme control and early theme script are delivered by the local app', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-theme-ui-'));
  const app = await startApp({ dataDir, port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const html = await (await fetch(app.url)).text();
  assert.match(html, /<button\b[^>]*id="theme-toggle"[^>]*aria-label="Switch to dark mode"/);
  const script = html.indexOf('<script src="/theme.js"></script>');
  assert.ok(script >= 0 && script < html.indexOf('rel="stylesheet"'), 'Theme must initialize before the page styles.');
  const response = await fetch(`${app.url}/theme.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
});

test('workspace controller and offline font are served to the browser', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-workspace-assets-'));
  const app = await startApp({ dataDir, port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const html = await (await fetch(app.url)).text();
  const controllerIndex = html.indexOf('<script src="/workspace.js" defer></script>');
  assert.ok(controllerIndex > 0 && controllerIndex < html.indexOf('<script src="/app.js"'), 'Workspace must load before the inventory uses its controls.');
  const script = await fetch(`${app.url}/workspace.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const font = await fetch(`${app.url}/inter-latin.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
});
