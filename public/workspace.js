'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 800px)');
  const shell = document.querySelector('.app-shell');
  const sidebar = $('app-sidebar');
  const main = $('main');
  const menu = $('mobile-menu');
  const toggle = $('sidebar-toggle');
  const scrim = $('sidebar-scrim');
  let collapsed = false;
  let drawerOpen = false;
  try { collapsed = document.cookie.split(';').some(part => part.trim() === 'office-inventory-sidebar=collapsed'); }
  catch { /* Navigation remains usable without storage. */ }

  function updateSidebar() {
    shell.classList.toggle('sidebar-collapsed', collapsed && !mobile.matches);
    shell.classList.toggle('sidebar-open', drawerOpen && mobile.matches);
    sidebar.inert = mobile.matches && !drawerOpen;
    main.inert = mobile.matches && drawerOpen;
    scrim.hidden = !mobile.matches || !drawerOpen;
    document.body.classList.toggle('navigation-open', mobile.matches && drawerOpen);
    menu.setAttribute('aria-expanded', String(drawerOpen && mobile.matches));
    menu.setAttribute('aria-label', drawerOpen ? 'Close navigation' : 'Open navigation');
    const label = mobile.matches ? 'Close navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(mobile.matches ? drawerOpen : !collapsed));
    toggle.title = label;
    $('sidebar-toggle-label').textContent = label;
  }

  function closeSidebar() {
    if (!drawerOpen) return;
    drawerOpen = false;
    updateSidebar();
    menu.focus();
  }

  menu.addEventListener('click', () => {
    drawerOpen = !drawerOpen;
    updateSidebar();
    if (drawerOpen) sidebar.querySelector('nav a').focus();
  });
  toggle.addEventListener('click', () => {
    if (mobile.matches) return closeSidebar();
    collapsed = !collapsed;
    updateSidebar();
    try { document.cookie = `office-inventory-sidebar=${collapsed ? 'collapsed' : 'expanded'}; Max-Age=31536000; Path=/; SameSite=Strict`; }
    catch { /* This page still keeps its current sidebar state. */ }
  });
  scrim.addEventListener('click', closeSidebar);
  sidebar.addEventListener('click', event => {
    if (event.target.closest('a, button')) closeSidebar();
  }, { capture: true });
  sidebar.querySelectorAll('nav a, nav button').forEach(link => {
    link.title = link.textContent.trim();
    link.setAttribute('aria-label', link.textContent.trim());
  });
  document.addEventListener('keydown', event => {
    if (!drawerOpen || !mobile.matches) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSidebar();
    } else if (event.key === 'Tab') {
      const items = [...sidebar.querySelectorAll('a[href], button:not(:disabled)')];
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  mobile.addEventListener('change', () => {
    const focusWasInside = sidebar.contains(document.activeElement);
    drawerOpen = false;
    updateSidebar();
    if (mobile.matches && focusWasInside) menu.focus();
  });
  updateSidebar();

  // Keep the native dialog's focus trap and Escape semantics throughout its exit.
  const dismissals = new WeakMap();
  function openDialog(dialog) {
    const pending = dismissals.get(dialog);
    if (pending) {
      clearTimeout(pending.timer);
      dismissals.delete(dialog);
      pending.resolve();
    }
    dialog.classList.remove('is-closing');
    if (!dialog.open) dialog.showModal();
  }
  function closeDialog(dialog) {
    if (dismissals.has(dialog)) return dismissals.get(dialog).promise;
    if (!dialog.open) return Promise.resolve();
    if (reducedMotion.matches) { dialog.close(); return Promise.resolve(); }
    dialog.classList.add('is-closing');
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const timer = setTimeout(() => {
      dismissals.delete(dialog);
      dialog.close();
      dialog.classList.remove('is-closing');
      resolve();
    }, 160);
    dismissals.set(dialog, { timer, promise, resolve });
    return promise;
  }
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      void closeDialog(dialog);
    });
  });
  document.querySelectorAll('[data-close]').forEach(button => {
    button.addEventListener('click', () => { void closeDialog($(button.dataset.close)); });
  });

  // Animate totals only when the dashboard is first revealed, never while editing.
  const counters = new WeakMap();
  function count(node, target, animate = true) {
    const previous = counters.get(node);
    if (previous !== undefined) cancelAnimationFrame(previous);
    counters.delete(node);
    if (!animate || reducedMotion.matches || target === 0) {
      node.textContent = target.toLocaleString();
      return;
    }
    const start = performance.now();
    node.textContent = '0';
    function tick(now) {
      const progress = Math.min(1, (now - start) / 900);
      node.textContent = Math.round(target * (1 - (1 - progress) ** 3)).toLocaleString();
      if (progress < 1 && !reducedMotion.matches) counters.set(node, requestAnimationFrame(tick));
      else { node.textContent = target.toLocaleString(); counters.delete(node); }
    }
    counters.set(node, requestAnimationFrame(tick));
  }
  window.inventoryUI = { openDialog, closeDialog, count };
})();
