import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function page({ mobile = false, reducedMotion = false, cookie = '' } = {}) {
  const document = new EventTarget();
  function element(id = '') {
    const node = new EventTarget();
    const classes = new Set();
    const attributes = new Map();
    Object.assign(node, {
      id, dataset: {}, style: {}, inert: false, textContent: '',
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force = !classes.has(name)) {
          if (force) classes.add(name); else classes.delete(name);
          return force;
        },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      focus() { document.activeElement = node; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    });
    return node;
  }
  const ids = Object.fromEntries([
    'app-sidebar', 'sidebar-toggle', 'sidebar-toggle-label',
    'mobile-menu', 'sidebar-scrim', 'main',
  ].map(id => [id, element(id)]));
  const shell = element();
  const nav = element();
  const link = element();
  ids['app-sidebar'].querySelector = selector => ({ nav, 'nav a': link })[selector] ?? null;
  ids['app-sidebar'].contains = node => [ids['app-sidebar'], nav, link].includes(node);
  const dialog = element();
  ids['example-dialog'] = dialog;
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')); };
  const dismiss = element();
  dismiss.dataset.close = 'example-dialog';
  dismiss.closest = selector => selector === 'dialog' ? dialog : null;
  dialog.querySelectorAll = selector => selector === '[data-close]' ? [dismiss] : [];
  document.readyState = 'complete';
  document.documentElement = element();
  document.body = element();
  document.activeElement = ids['mobile-menu'];
  document.getElementById = id => ids[id] ?? null;
  document.querySelector = selector => ({ '.app-shell': shell, '#app-sidebar nav': nav })[selector] ?? null;
  document.querySelectorAll = selector => ({ dialog: [dialog], '[data-close]': [dismiss] })[selector] ?? [];
  let savedCookie = cookie;
  Object.defineProperty(document, 'cookie', {
    get() { return savedCookie; },
    set(value) { savedCookie = value.split(';')[0]; },
  });
  const mobileQuery = new EventTarget();
  mobileQuery.matches = mobile;
  const motionQuery = new EventTarget();
  motionQuery.matches = reducedMotion;
  let now = 0;
  let sequence = 0;
  const frames = new Map();
  const timers = new Map();
  const browser = {
    matchMedia(query) {
      if (query === '(max-width: 800px)') return mobileQuery;
      if (query === '(prefers-reduced-motion: reduce)') return motionQuery;
      throw new Error(`Unexpected media query: ${query}`);
    },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay = 0) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    performance: { now: () => now },
  };
  const source = readFileSync(new URL('../public/workspace.js', import.meta.url), 'utf8');
  runInNewContext(source, { document, window: browser, ...browser });
  return {
    ui: browser.inventoryUI, ids, shell, dialog, dismiss, document, frames, timers, element,
    get cookie() { return savedCookie; },
    click(id) { ids[id].dispatchEvent(new Event('click')); },
    frame(time) {
      now = time;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(now));
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now && timers.delete(id)) timer.callback();
      }
    },
    resize(isMobile) { mobileQuery.matches = isMobile; mobileQuery.dispatchEvent(new Event('change')); },
    escape() {
      const event = new Event('keydown', { cancelable: true });
      Object.defineProperty(event, 'key', { value: 'Escape' });
      document.dispatchEvent(event);
    },
  };
}

test('replacement count animation reaches the new target without stale frame updates', () => {
  const app = page();
  const value = app.element();
  value.textContent = '0';
  app.ui.count(value, 90);
  app.frame(0);
  app.frame(100);
  const previousFrame = [...app.frames.keys()][0];
  app.ui.count(value, 37);
  assert.equal(app.frames.has(previousFrame), false);
  assert.equal(app.frames.size, 1);
  for (let time = 150; time <= 2000; time += 50) app.frame(time);
  assert.equal(String(value.textContent), '37');
  assert.equal(app.frames.size, 0);
});

test('nonanimated count update cancels an in-progress animation', () => {
  const app = page();
  const value = app.element();
  value.textContent = '0';
  app.ui.count(value, 90);
  app.frame(0);
  app.frame(100);
  app.ui.count(value, 12, false);
  assert.equal(String(value.textContent), '12');
  assert.equal(app.frames.size, 0);
  app.frame(2000);
  assert.equal(String(value.textContent), '12');
});

test('reduced motion displays the exact count without scheduling animation', () => {
  const app = page({ reducedMotion: true });
  const value = app.element();
  app.ui.count(value, 73);
  assert.equal(String(value.textContent), '73');
  assert.equal(app.frames.size, 0);
});

test('reopening a dialog cancels its pending animated dismissal', () => {
  const app = page();
  app.ui.openDialog(app.dialog);
  app.ui.closeDialog(app.dialog);
  app.advance(80);
  app.ui.openDialog(app.dialog);
  app.advance(500);
  assert.equal(app.dialog.open, true);
});

test('repeated dialog dismissal waits for one close transition', async () => {
  const app = page();
  app.ui.openDialog(app.dialog);
  const first = app.ui.closeDialog(app.dialog);
  const second = app.ui.closeDialog(app.dialog);
  assert.equal(app.timers.size, 1);
  app.advance(159);
  assert.equal(app.dialog.open, true);
  app.advance(1);
  await Promise.all([first, second]);
  assert.equal(app.dialog.open, false);
  assert.equal(app.timers.size, 0);
});

test('reduced motion closes dialogs immediately', async () => {
  const app = page({ reducedMotion: true });
  app.ui.openDialog(app.dialog);
  await app.ui.closeDialog(app.dialog);
  assert.equal(app.dialog.open, false);
  assert.equal(app.timers.size, 0);
});

test('native dialog cancellation keeps the modal open until its exit finishes', () => {
  const app = page();
  app.ui.openDialog(app.dialog);
  const cancel = new Event('cancel', { cancelable: true });
  app.dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(app.dialog.open, true);
  app.advance(160);
  assert.equal(app.dialog.open, false);
});

test('dismiss buttons close their associated dialog', () => {
  const app = page();
  app.ui.openDialog(app.dialog);
  app.dismiss.dispatchEvent(new Event('click'));
  app.advance(160);
  assert.equal(app.dialog.open, false);
});

test('desktop collapse preference survives a reload and can be expanded again', () => {
  const first = page();
  first.click('sidebar-toggle');
  assert.equal(first.shell.classList.contains('sidebar-collapsed'), true);
  assert.equal(first.cookie, 'office-inventory-sidebar=collapsed');
  const second = page({ cookie: first.cookie });
  assert.equal(second.shell.classList.contains('sidebar-collapsed'), true);
  second.click('sidebar-toggle');
  assert.equal(second.shell.classList.contains('sidebar-collapsed'), false);
  assert.equal(second.cookie, 'office-inventory-sidebar=expanded');
});

test('mobile drawer gates keyboard access and Escape restores the page', () => {
  const app = page({ mobile: true });
  assert.equal(app.ids['app-sidebar'].inert, true);
  assert.equal(app.ids.main.inert, false);
  app.click('mobile-menu');
  assert.equal(app.shell.classList.contains('sidebar-open'), true);
  assert.equal(app.ids['app-sidebar'].inert, false);
  assert.equal(app.ids.main.inert, true);
  app.escape();
  assert.equal(app.shell.classList.contains('sidebar-open'), false);
  assert.equal(app.ids['app-sidebar'].inert, true);
  assert.equal(app.ids.main.inert, false);
  assert.equal(app.document.activeElement, app.ids['mobile-menu']);
});

test('mobile Home link outside nav dismisses the drawer and restores page access', () => {
  const app = page({ mobile: true });
  app.click('mobile-menu');
  assert.equal(app.ids['sidebar-scrim'].hidden, false);
  assert.equal(app.ids.main.inert, true);

  const home = app.element();
  home.closest = selector => selector === 'a, button' ? home : null;
  const click = new Event('click', { bubbles: true });
  Object.defineProperty(click, 'target', { value: home });
  // The brand link is a sidebar child outside nav; deliver its captured click.
  app.ids['app-sidebar'].dispatchEvent(click);

  assert.equal(app.shell.classList.contains('sidebar-open'), false);
  assert.equal(app.ids['sidebar-scrim'].hidden, true);
  assert.equal(app.ids.main.inert, false);
  assert.equal(app.ids['app-sidebar'].inert, true);
});

test('breakpoint changes clear drawer state and restore desktop accessibility', () => {
  const app = page({ mobile: true, cookie: 'office-inventory-sidebar=collapsed' });
  app.click('mobile-menu');
  app.resize(false);
  assert.equal(app.shell.classList.contains('sidebar-open'), false);
  assert.equal(app.shell.classList.contains('sidebar-collapsed'), true);
  assert.equal(app.ids.main.inert, false);
  assert.equal(app.ids['app-sidebar'].inert, false);
  app.resize(true);
  assert.equal(app.ids.main.inert, false);
  assert.equal(app.ids['app-sidebar'].inert, true);
});
