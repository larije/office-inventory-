import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');

function page({ cookie = '', systemDark = false, blocked = false } = {}) {
  const document = new EventTarget();
  document.documentElement = { dataset: {} };
  document.readyState = 'loading';
  let savedCookie = cookie;
  Object.defineProperty(document, 'cookie', {
    get() { if (blocked) throw new Error('Browser storage is blocked'); return savedCookie; },
    set(value) { if (blocked) throw new Error('Browser storage is blocked'); savedCookie = value.split(';')[0]; },
  });
  const button = new EventTarget();
  const attributes = new Map();
  button.setAttribute = (key, value) => attributes.set(key, value);
  const label = { textContent: '' };
  document.getElementById = id => ({ 'theme-toggle': button, 'theme-toggle-label': label })[id] || null;
  const preference = new EventTarget();
  preference.matches = systemDark;
  runInNewContext(source, { document, window: { matchMedia: () => preference } });
  return {
    document, button, label, attributes,
    get theme() { return document.documentElement.dataset.theme; },
    get cookie() { return savedCookie; },
    ready() { document.readyState = 'interactive'; document.dispatchEvent(new Event('DOMContentLoaded')); },
    toggle() { button.dispatchEvent(new Event('click')); },
    system(dark) { preference.matches = dark; preference.dispatchEvent(new Event('change')); },
  };
}

test('fresh page starts light before content loads even with a dark system theme', () => {
  const app = page({ systemDark: true });
  assert.equal(app.theme, 'light');
  app.system(false);
  assert.equal(app.theme, 'light');
  app.system(true);
  assert.equal(app.theme, 'light');
  app.ready();
  app.toggle();
  assert.equal(app.theme, 'dark');
  app.system(false);
  assert.equal(app.theme, 'dark');
});

test('saved light preference wins over dark system preference', () => {
  const app = page({ cookie: 'another=value; office-inventory-theme=light', systemDark: true });
  assert.equal(app.theme, 'light');
  app.ready();
  assert.equal(app.label.textContent, 'Dark mode');
  assert.equal(app.attributes.get('aria-label'), 'Switch to dark mode');
});

test('toggle updates its accessible action and remembers both choices on a fresh page', () => {
  const first = page();
  first.ready();
  first.toggle();
  assert.equal(first.theme, 'dark');
  assert.equal(first.label.textContent, 'Light mode');
  assert.equal(first.attributes.get('aria-label'), 'Switch to light mode');
  const second = page({ cookie: first.cookie });
  assert.equal(second.theme, 'dark');
  second.ready();
  second.toggle();
  assert.equal(second.theme, 'light');
  assert.equal(page({ cookie: second.cookie, systemDark: true }).theme, 'light');
});

test('invalid stored theme falls back to light', () => {
  assert.equal(page({ cookie: 'office-inventory-theme=unknown', systemDark: true }).theme, 'light');
});

test('blocked browser storage does not prevent theme switching', () => {
  const app = page({ blocked: true, systemDark: true });
  assert.equal(app.theme, 'light');
  app.ready();
  assert.doesNotThrow(() => app.toggle());
  assert.equal(app.theme, 'dark');
  app.toggle();
  assert.equal(app.theme, 'light');
});
