'use strict';

(() => {
  const key = 'office-inventory-theme';
  let preference = null;
  try {
    const saved = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${key}=`))?.slice(key.length + 1);
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* The theme still works when browser storage is blocked. */ }

  function updateButton() {
    const button = document.getElementById('theme-toggle');
    const label = document.getElementById('theme-toggle-label');
    if (!button || !label) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    label.textContent = dark ? 'Light mode' : 'Dark mode';
    const action = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-label', action);
    button.title = action;
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    updateButton();
  }

  // Runs before the stylesheet to avoid flashing the wrong theme on reload.
  applyTheme(preference || 'light');

  function bindToggle() {
    updateButton();
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(preference);
      try {
        // Cookies survive the launcher's port changes on this same local host.
        document.cookie = `${key}=${preference}; Max-Age=31536000; Path=/; SameSite=Strict`;
      } catch { /* Keep the selected theme for this page even without storage. */ }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindToggle, { once: true });
  else bindToggle();
})();
