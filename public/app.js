'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let equipmentId = null;
  let employeeId = null;
  let detailId = null;
  let pendingSnapshot = null;
  let previewGeneration = 0;
  let historyGeneration = 0;
  let saveInProgress = false;
  let dashboardCountShown = false;
  let activeView = null;
  const ui = window.inventoryUI;
  const equipmentFields = ['propertyNumber', 'name', 'category', 'brand', 'model', 'serialNumber', 'employeeId', 'location', 'condition', 'notes'];
  const divisionNames = {
    LTSAD: 'Local Treasury Systems Administration Division',
    CRADD: 'Cash Receipt and Disbursement Division',
    LTOD: 'Local Treasury Operations Division',
    REVDIV: 'Revenue Division',
  };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function show(node, visible) { node.classList.toggle('hidden', !visible); }
  function dateText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }
  function employeeName(id) {
    return state.employees.find((employee) => employee.id === id)?.name || 'Unassigned';
  }

  function notify(message, isError = false) {
    $('notice-text').textContent = message;
    $('notice').classList.toggle('error', isError);
    show($('notice'), true);
  }
  function formError(id, message = '') {
    $(id).textContent = message;
    show($(id), Boolean(message));
  }

  async function request(path, method = 'GET', data) {
    const options = { method, cache: 'no-store' };
    if (method !== 'GET') {
      options.headers = { 'Content-Type': 'application/json', 'X-Inventory-Request': '1' };
      options.body = JSON.stringify(data);
    }
    let response;
    try { response = await fetch(path, options); }
    catch { throw new Error('Cannot reach the inventory app. Check that it is running, then try again.'); }
    let body;
    try { body = await response.json(); }
    catch { throw new Error('The app returned an unreadable response. Please try again.'); }
    if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
    return body;
  }

  async function reloadState() {
    state = await request('/api/state');
    $('office-label').textContent = state.settings.officeName || 'Office Inventory';
    $('brand-office-name').textContent = state.settings.officeName || 'Office Inventory';
    document.title = state.settings.officeName ? `${state.settings.officeName} · Office Inventory` : 'Office Inventory';
    $('office-name').value = state.settings.officeName;
    renderEmployeeFilter();
    renderEquipment();
    renderEmployees();
    renderDashboard();
    show($('loading'), false);
    navigate();
  }

  function navigate() {
    const requested = location.hash.slice(1);
    const views = ['dashboard', 'equipment', 'employees', 'backup'];
    const view = views.includes(requested) ? requested : 'dashboard';
    for (const name of views) show($(`${name}-view`), Boolean(state) && name === view);
    if (state && activeView !== view) {
      if (activeView !== null) window.scrollTo({ top: 0, behavior: 'instant' });
      activeView = view;
      if (view === 'dashboard' && !dashboardCountShown) {
        dashboardCountShown = true;
        const active = state.equipment.filter(item => !item.archived);
        const assigned = active.filter(item => item.employeeId).length;
        const totals = {
          'dash-total': active.length,
          'dash-assigned': assigned,
          'dash-unassigned': active.length - assigned,
          'dash-employees': state.employees.filter(employee => employee.active).length,
          'dash-attention-count': active.filter(item => item.condition !== 'Good').length,
          'chart-total': active.length,
        };
        for (const [id, total] of Object.entries(totals)) ui.count($(id), total);
      }
    }
    $('breadcrumb-view').textContent = { dashboard: 'Dashboard', equipment: 'Equipment', employees: 'Employees', backup: 'Save & Load' }[view];
    document.querySelectorAll('nav [data-view]').forEach((link) => {
      const active = link.dataset.view === view;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function option(value, label) {
    const node = element('option', label);
    node.value = value;
    return node;
  }
  function sortedEmployees() { return [...state.employees].sort((a, b) => a.name.localeCompare(b.name)); }
  function renderEmployeeFilter() {
    const selected = $('employee-filter').value;
    $('employee-filter').replaceChildren(option('', 'All employees'), option('assigned', 'Assigned'), option('unassigned', 'Unassigned'));
    sortedEmployees().forEach((employee) => $('employee-filter').append(option(employee.id, `${employee.name}${employee.active ? '' : ' (inactive)'}`)));
    if ([...$('employee-filter').options].some((entry) => entry.value === selected)) $('employee-filter').value = selected;
  }

  function filteredEquipment() {
    const search = $('search').value.trim().toLocaleLowerCase();
    const employee = $('employee-filter').value;
    const condition = $('condition-filter').value;
    const archived = $('archive-filter').value;
    return state.equipment.filter((item) => {
      if (archived === 'active' && item.archived) return false;
      if (archived === 'archived' && !item.archived) return false;
      if (condition === 'attention' && item.condition === 'Good') return false;
      if (condition && condition !== 'attention' && item.condition !== condition) return false;
      if (employee === 'assigned' && !item.employeeId) return false;
      if (employee === 'unassigned' && item.employeeId) return false;
      if (employee && !['assigned', 'unassigned'].includes(employee) && item.employeeId !== employee) return false;
      if (search && ![item.propertyNumber, item.name, item.category, item.brand, item.model, item.serialNumber, item.location, item.notes, employeeName(item.employeeId)].join(' ').toLocaleLowerCase().includes(search)) return false;
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name) || a.propertyNumber.localeCompare(b.propertyNumber));
  }

  function conditionBadge(condition) {
    const type = condition === 'Needs repair' ? 'repair' : condition === 'Unserviceable' ? 'unserviceable' : '';
    return element('span', condition, `badge ${type}`);
  }

  function actionButton(label, action, className = 'subtle') {
    const button = element('button', label, className);
    button.type = 'button';
    button.addEventListener('click', action);
    return button;
  }

  function openEquipmentFilter(filter = '') {
    $('search').value = '';
    $('employee-filter').value = ['assigned', 'unassigned'].includes(filter) ? filter : '';
    $('condition-filter').value = ['attention', 'Good', 'Needs repair', 'Unserviceable'].includes(filter) ? filter : '';
    $('archive-filter').value = 'active';
    renderEquipment();
    location.hash = 'equipment';
    navigate();
  }

  function shortDate(value) {
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderDashboard() {
    const active = state.equipment.filter((item) => !item.archived);
    const assigned = active.filter((item) => item.employeeId).length;
    const attention = active.filter((item) => item.condition !== 'Good').length;
    ui.count($('dash-total'), active.length, false);
    ui.count($('dash-assigned'), assigned, false);
    ui.count($('dash-unassigned'), active.length - assigned, false);
    ui.count($('dash-employees'), state.employees.filter((employee) => employee.active).length, false);
    ui.count($('dash-attention-count'), attention, false);
    $('dash-attention-copy').textContent = attention
      ? `${plural(attention, 'item')} marked for repair or unserviceable`
      : 'No active equipment is marked for repair or unserviceable';
    ui.count($('chart-total'), active.length, false);
    $('chart-caption').textContent = 'active items';
    $('chart-total-label').textContent = `${active.length} total`;

    const conditions = [
      { name: 'Good', className: 'good', color: '#10b981' },
      { name: 'Needs repair', className: 'repair', color: '#f59e0b' },
      { name: 'Unserviceable', className: 'unserviceable', color: '#ef4444' }
    ].map((condition) => ({ ...condition, count: active.filter((item) => item.condition === condition.name).length }));
    const chart = $('condition-chart');
    chart.replaceChildren();
    chart.setAttribute('aria-label', `Equipment condition: ${conditions.map((entry) => `${entry.count} ${entry.name.toLowerCase()}`).join(', ')}.`);
    const circumference = 2 * Math.PI * 62;
    function ring(color) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      for (const [key, value] of Object.entries({ cx: 80, cy: 80, r: 62, fill: 'none', stroke: color, 'stroke-width': 20 })) circle.setAttribute(key, value);
      chart.append(circle);
      return circle;
    }
    ring('var(--chart-track, #eef1f6)');
    let offset = 0;
    const segments = conditions.filter((entry) => entry.count > 0).length;
    for (const entry of conditions) {
      if (!entry.count) continue;
      const length = entry.count / active.length * circumference;
      const circle = ring(entry.color);
      circle.setAttribute('stroke-dasharray', `${Math.max(0, length - (segments > 1 ? Math.min(3, length / 4) : 0))} ${circumference}`);
      circle.setAttribute('stroke-dashoffset', -offset);
      circle.setAttribute('transform', 'rotate(-90 80 80)');
      offset += length;
    }
    $('condition-legend').replaceChildren();
    for (const entry of conditions) {
      const button = actionButton('', () => openEquipmentFilter(entry.name), 'legend-item');
      button.setAttribute('aria-label', `Show ${entry.count} ${entry.name.toLowerCase()} equipment`);
      const dot = element('span', undefined, `legend-dot ${entry.className}`);
      dot.setAttribute('aria-hidden', 'true');
      button.append(dot, element('span', entry.name, 'legend-label'), element('strong', entry.count, 'legend-count'));
      $('condition-legend').append(button);
    }

    const updated = [...active].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
    $('dashboard-updated-list').replaceChildren();
    for (const item of updated) {
      const button = actionButton('', () => openDetail(item.id), 'recent-update');
      button.setAttribute('aria-label', `View latest record for ${item.name}, ${item.propertyNumber}`);
      const icon = element('span', undefined, 'recent-update-icon');
      icon.setAttribute('aria-hidden', 'true');
      const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      glyph.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M14 3H6v18h12V7z M14 3v5h4 M9 12h6 M9 16h4');
      glyph.append(path);
      icon.append(glyph);
      const copy = element('span', undefined, 'recent-update-copy');
      copy.append(element('span', item.name, 'recent-update-name'), element('span', `${employeeName(item.employeeId)} · ${shortDate(item.updatedAt)}`, 'recent-update-meta'));
      button.append(icon, copy, element('span', '↗', 'recent-update-arrow'));
      $('dashboard-updated-list').append(button);
    }
    show($('dashboard-updated-empty'), updated.length === 0);

    const recent = [...active].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
    $('dashboard-recent-rows').replaceChildren();
    for (const item of recent) {
      const row = element('tr');
      const property = element('td');
      const link = actionButton(item.propertyNumber, () => openDetail(item.id), 'property-link');
      link.setAttribute('aria-label', `View equipment ${item.propertyNumber}`);
      property.append(link);
      const condition = element('td');
      condition.append(conditionBadge(item.condition));
      row.append(property, element('td', item.name), element('td', employeeName(item.employeeId)), element('td', item.location || '—'), condition, element('td', shortDate(item.createdAt)));
      $('dashboard-recent-rows').append(row);
    }
    show($('dashboard-recent-table'), recent.length > 0);
    show($('dashboard-empty'), recent.length === 0);
  }

  function updateClock() {
    const now = new Date();
    $('current-date').textContent = shortDate(now);
    $('current-time').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function renderEquipment() {
    const active = state.equipment.filter((item) => !item.archived);
    $('total-active').textContent = active.length;
    $('total-assigned').textContent = active.filter((item) => item.employeeId).length;
    $('total-unassigned').textContent = active.filter((item) => !item.employeeId).length;
    $('total-attention').textContent = active.filter((item) => item.condition !== 'Good').length;
    const items = filteredEquipment();
    $('equipment-count').textContent = `${plural(items.length, 'item')} shown · ${plural(state.equipment.length, 'item')} total`;
    $('equipment-rows').replaceChildren();
    for (const item of items) {
      const row = element('tr');
      const nameCell = element('td');
      const nameButton = actionButton(item.name, () => openDetail(item.id), 'item-name');
      nameButton.setAttribute('aria-label', `View details for ${item.name}, ${item.propertyNumber}`);
      nameCell.append(nameButton, element('span', item.propertyNumber, 'row-sub'));
      if (item.archived) nameCell.append(element('span', 'Archived', 'badge archived'));
      const personCell = element('td', employeeName(item.employeeId), item.employeeId ? '' : 'cell-muted');
      const actions = element('td', undefined, 'row-actions');
      const edit = actionButton('Edit', () => openEquipment(item.id));
      edit.setAttribute('aria-label', `Edit ${item.name}, ${item.propertyNumber}`);
      actions.append(edit);
      const conditionCell = element('td');
      conditionCell.append(conditionBadge(item.condition));
      row.append(nameCell, personCell, element('td', item.location || '—', item.location ? '' : 'cell-muted'), conditionCell, actions);
      $('equipment-rows').append(row);
    }
    show($('equipment-table'), items.length > 0);
    show($('equipment-empty'), items.length === 0);
    const firstUse = state.equipment.length === 0;
    $('empty-title').textContent = firstUse ? 'Your equipment register starts here' : 'No equipment matches this view';
    $('empty-copy').textContent = firstUse ? 'Add your first item, then assign it to an employee.' : 'Try a different search or clear the filters to see your active equipment.';
    show($('empty-add'), firstUse);
    show($('clear-filters'), !firstUse);
    $('export-csv').disabled = items.length === 0;
    $('print-equipment').disabled = items.length === 0;
  }

  function renderEmployees() {
    const division = $('employee-division-filter').value;
    const employees = sortedEmployees().filter((employee) => !division || (division === 'none' ? !employee.division : employee.division === division));
    $('employee-count').textContent = `${plural(employees.length, 'employee')} shown · ${state.employees.length} total · ${state.employees.filter((employee) => employee.active).length} active`;
    $('employee-rows').replaceChildren();
    for (const employee of employees) {
      const row = element('tr');
      const count = state.equipment.filter((item) => !item.archived && item.employeeId === employee.id).length;
      const badgeCell = element('td');
      badgeCell.append(element('span', employee.active ? 'Active' : 'Inactive', employee.active ? 'badge' : 'badge inactive'));
      const actionCell = element('td', undefined, 'row-actions');
      const edit = actionButton('Edit', () => openEmployee(employee.id));
      edit.setAttribute('aria-label', `Edit employee ${employee.name}`);
      actionCell.append(edit);
      const divisionCell = element('td', employee.division || 'No division', employee.division ? 'employee-division' : 'cell-muted');
      if (divisionNames[employee.division]) divisionCell.append(element('span', divisionNames[employee.division], 'row-sub'));
      row.append(element('td', employee.employeeNumber || '—', 'employee-number'), element('td', employee.name, 'employee-name'), element('td', employee.position || '—', employee.position ? '' : 'cell-muted'), divisionCell, element('td', plural(count, 'item')), badgeCell, actionCell);
      $('employee-rows').append(row);
    }
    show($('employees-table'), employees.length > 0);
    show($('employees-empty'), state.employees.length === 0);
    show($('employees-filter-empty'), state.employees.length > 0 && employees.length === 0);
  }

  function openEquipment(id = null) {
    equipmentId = id;
    const item = state.equipment.find((entry) => entry.id === id);
    $('equipment-form').reset();
    formError('equipment-error');
    $('equipment-form-title').textContent = id ? 'Edit equipment' : 'Add equipment';
    const select = $('equipment-employee');
    select.replaceChildren(option('', 'Unassigned'));
    sortedEmployees().filter((employee) => employee.active || employee.id === item?.employeeId).forEach((employee) => select.append(option(employee.id, `${employee.name}${employee.active ? '' : ' (inactive)'}`)));
    for (const field of equipmentFields) $('equipment-form').elements.namedItem(field).value = item?.[field] ?? (field === 'condition' ? 'Good' : '');
    ui.openDialog($('equipment-dialog'));
    $('equipment-form').elements.namedItem('propertyNumber').focus();
  }

  function openEmployee(id = null) {
    employeeId = id;
    const employee = state.employees.find((entry) => entry.id === id);
    $('employee-form').reset();
    formError('employee-error');
    $('employee-form-title').textContent = id ? 'Edit employee' : 'Add employee';
    for (const field of ['employeeNumber', 'name', 'position', 'division']) $('employee-form').elements.namedItem(field).value = employee?.[field] || '';
    $('employee-form').elements.namedItem('active').checked = employee?.active ?? true;
    ui.openDialog($('employee-dialog'));
    $('employee-form').elements.namedItem('name').focus();
  }

  function addFact(parent, name, value, valueClass) {
    const row = element('div', undefined, 'fact-row');
    row.append(element('dt', name), element('dd', value || '—', valueClass));
    parent.append(row);
  }

  async function openDetail(id) {
    detailId = id;
    const item = state.equipment.find((entry) => entry.id === id);
    if (!item) return;
    $('detail-title').textContent = item.name;
    const facts = element('dl', undefined, 'facts');
    const labels = { propertyNumber: 'Property number', category: 'Category', brand: 'Brand', model: 'Model', serialNumber: 'Serial number', location: 'Location', condition: 'Condition', notes: 'Notes' };
    for (const [key, label] of Object.entries(labels)) addFact(facts, label, item[key], key === 'notes' ? 'detail-notes' : '');
    addFact(facts, 'Assigned to', employeeName(item.employeeId));
    addFact(facts, 'Status', item.archived ? 'Archived' : 'Active');
    $('detail-content').replaceChildren(facts);
    $('detail-archive').textContent = item.archived ? 'Restore equipment' : 'Archive equipment';
    $('history-list').replaceChildren(element('p', 'Loading history…', 'help-text'));
    ui.openDialog($('detail-dialog'));
    const generation = ++historyGeneration;
    try {
      const history = await request(`/api/equipment/${encodeURIComponent(id)}/history`);
      if (generation !== historyGeneration || detailId !== id) return;
      $('history-list').replaceChildren();
      if (!history.length) $('history-list').append(element('p', 'No recorded changes yet.', 'help-text'));
      [...history].sort((a, b) => b.at.localeCompare(a.at)).forEach((entry) => {
        const block = element('div', undefined, 'history-item');
        const time = element('time', dateText(entry.at));
        time.dateTime = entry.at;
        block.append(element('p', entry.summary), time);
        $('history-list').append(block);
      });
    } catch (error) {
      if (generation === historyGeneration) $('history-list').replaceChildren(element('p', error.message, 'form-error'));
    }
  }

  function busy(button, value, busyLabel) {
    if (value) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = busyLabel;
    } else if (button.dataset.originalLabel) {
      button.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
    button.disabled = value;
  }

  async function submitEquipment(event) {
    event.preventDefault();
    const form = $('equipment-form');
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const data = {};
    for (const key of equipmentFields) data[key] = form.elements.namedItem(key).value.trim();
    data.employeeId ||= null;
    const existing = state.equipment.find((item) => item.id === equipmentId);
    data.archived = existing?.archived ?? false;
    if (!data.propertyNumber || !data.name) { formError('equipment-error', 'Enter a property number and equipment name.'); return; }
    busy(button, true, 'Saving…');
    formError('equipment-error');
    try {
      await request(equipmentId ? `/api/equipment/${encodeURIComponent(equipmentId)}` : '/api/equipment', equipmentId ? 'PUT' : 'POST', data);
      await ui.closeDialog($('equipment-dialog'));
      await reloadState();
      notify('Equipment saved. The change is recorded in its history.');
    } catch (error) {
      if ($('equipment-dialog').open) formError('equipment-error', error.message);
      else notify(error.message, true);
    } finally { busy(button, false); }
  }

  async function submitEmployee(event) {
    event.preventDefault();
    const form = $('employee-form');
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const data = Object.fromEntries(['employeeNumber', 'name', 'position', 'division'].map((field) => [field, form.elements.namedItem(field).value.trim()]));
    data.active = form.elements.namedItem('active').checked;
    if (!data.name) { formError('employee-error', 'Enter the employee’s name.'); return; }
    busy(button, true, 'Saving…');
    formError('employee-error');
    try {
      await request(employeeId ? `/api/employees/${encodeURIComponent(employeeId)}` : '/api/employees', employeeId ? 'PUT' : 'POST', data);
      await ui.closeDialog($('employee-dialog'));
      await reloadState();
      notify('Employee saved.');
    } catch (error) {
      if ($('employee-dialog').open) formError('employee-error', error.message);
      else notify(error.message, true);
    } finally { busy(button, false); }
  }

  async function toggleArchived() {
    const item = state.equipment.find((entry) => entry.id === detailId);
    const button = $('detail-archive');
    if (!item || button.disabled) return;
    busy(button, true, 'Saving…');
    try {
      await request(`/api/equipment/${encodeURIComponent(item.id)}`, 'PUT', { archived: !item.archived });
      await ui.closeDialog($('detail-dialog'));
      await reloadState();
      notify(item.archived ? 'Equipment restored to the active register.' : 'Equipment archived. Its record and history are preserved.');
    } catch (error) { notify(error.message, true); void ui.closeDialog($('detail-dialog')); }
    finally { busy(button, false); }
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = element('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function downloadSave() {
    const button = $('download-save');
    if (button.disabled) return;
    busy(button, true, 'Preparing save…');
    try {
      const response = await fetch('/api/backups/download', { cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || 'Could not create an inventory save.');
      }
      const blob = await response.blob();
      const metadata = JSON.parse(await blob.text());
      const safeDate = String(metadata.savedAt).replace(/[^0-9T-]/g, '').slice(0, 19);
      download(blob, `office-inventory-${safeDate}.inventory`);
      $('last-saved').textContent = dateText(metadata.savedAt);
      try { localStorage.setItem('office-inventory-last-download', metadata.savedAt); } catch { /* Downloads still work without browser storage. */ }
      notify('Inventory save downloaded. Keep this file for moving or restoring your register.');
    } catch (error) { notify(error.message || 'Could not download the inventory save.', true); }
    finally { busy(button, false); }
  }

  function clearPreview() {
    previewGeneration++;
    pendingSnapshot = null;
    $('backup-file').value = '';
    show($('backup-preview'), false);
    formError('preview-error');
  }

  async function previewFile() {
    const generation = ++previewGeneration;
    const file = $('backup-file').files[0];
    pendingSnapshot = null;
    show($('backup-preview'), false);
    formError('preview-error');
    if (!file) return;
    $('backup-file').disabled = true;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('This save is too large to load. Choose a file smaller than 25 MB.');
      let snapshot;
      try { snapshot = JSON.parse(await file.text()); }
      catch { throw new Error('This file is not a readable inventory save. Please choose a valid .inventory file.'); }
      const preview = await request('/api/backups/preview', 'POST', snapshot);
      if (generation !== previewGeneration) return;
      pendingSnapshot = snapshot;
      $('preview-facts').replaceChildren();
      addFact($('preview-facts'), 'Office', preview.officeName);
      addFact($('preview-facts'), 'Saved on', dateText(preview.savedAt));
      addFact($('preview-facts'), 'Equipment', String(preview.equipmentCount));
      addFact($('preview-facts'), 'Employees', String(preview.employeeCount));
      addFact($('preview-facts'), 'History entries', String(preview.historyCount));
      show($('backup-preview'), true);
    } catch (error) { if (generation === previewGeneration) formError('preview-error', error.message); }
    finally { $('backup-file').disabled = false; }
  }

  async function restoreSave() {
    if (!pendingSnapshot || saveInProgress) return;
    const snapshot = pendingSnapshot;
    saveInProgress = true;
    busy($('restore-save'), true, 'Loading inventory…');
    $('cancel-preview').disabled = true;
    $('backup-file').disabled = true;
    formError('preview-error');
    try {
      const result = await request('/api/backups/restore', 'POST', { snapshot, confirm: true });
      clearPreview();
      await reloadState();
      $('recovery-notice').textContent = `Inventory loaded from ${dateText(result.summary.savedAt)}. Your previous register was saved to: ${result.recoveryFile}`;
      show($('recovery-notice'), true);
      notify('Inventory loaded. The current register now matches the selected save.');
    } catch (error) { formError('preview-error', error.message); }
    finally {
      saveInProgress = false;
      busy($('restore-save'), false);
      $('cancel-preview').disabled = false;
      $('backup-file').disabled = false;
    }
  }

  const exportColumns = [
    ['Property number', 'propertyNumber'], ['Equipment name', 'name'], ['Category', 'category'],
    ['Brand', 'brand'], ['Model', 'model'], ['Serial number', 'serialNumber'], ['Assigned employee', 'employeeId'],
    ['Location', 'location'], ['Condition', 'condition'], ['Notes', 'notes'], ['Archived', 'archived']
  ];
  function exportValue(item, key) {
    if (key === 'employeeId') return employeeName(item.employeeId);
    if (key === 'archived') return item.archived ? 'Yes' : 'No';
    return item[key] ?? '';
  }
  function csvCell(value) {
    let text = String(value);
    // Neutralize formula prefixes, including prefixes hidden behind whitespace.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  function exportCsv() {
    const rows = [exportColumns.map(([label]) => csvCell(label)).join(',')];
    filteredEquipment().forEach((item) => rows.push(exportColumns.map(([, key]) => csvCell(exportValue(item, key))).join(',')));
    download(new Blob(['\uFEFF', rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'office-equipment.csv');
  }

  function printList() {
    const items = filteredEquipment();
    const area = $('print-area');
    area.replaceChildren(element('h1', state.settings.officeName || 'Office Inventory'), element('p', `Equipment register · ${plural(items.length, 'item')} · Printed ${new Date().toLocaleDateString()}`));
    const filters = [];
    if ($('search').value.trim()) filters.push(`Search: ${$('search').value.trim()}`);
    if ($('employee-filter').value) filters.push(`Employee: ${$('employee-filter').selectedOptions[0].textContent}`);
    if ($('condition-filter').value) filters.push(`Condition: ${$('condition-filter').value}`);
    filters.push($('archive-filter').selectedOptions[0].textContent);
    area.append(element('p', filters.join(' · ')));
    const table = element('table');
    const head = element('thead');
    const heading = element('tr');
    ['Property no.', 'Equipment', 'Serial no.', 'Assigned employee', 'Location', 'Condition', 'Status'].forEach((title) => heading.append(element('th', title)));
    head.append(heading);
    const body = element('tbody');
    for (const item of items) {
      const row = element('tr');
      [item.propertyNumber, item.name, item.serialNumber || '—', employeeName(item.employeeId), item.location || '—', item.condition, item.archived ? 'Archived' : 'Active'].forEach((value) => row.append(element('td', value)));
      body.append(row);
    }
    table.append(head, body);
    area.append(table);
    window.print();
  }

  for (const select of [$('employee-division-filter'), $('employee-form').elements.namedItem('division')]) {
    for (const entry of select.options) {
      if (divisionNames[entry.value]) entry.textContent = `${entry.value} — ${divisionNames[entry.value]}`;
    }
  }
  $('add-equipment').addEventListener('click', () => openEquipment());
  for (const id of ['sidebar-add-equipment', 'dashboard-add-equipment', 'dashboard-add-first']) $(id).addEventListener('click', () => { if (state) openEquipment(); });
  document.querySelectorAll('[data-equipment-filter]').forEach((button) => button.addEventListener('click', () => { if (state) openEquipmentFilter(button.dataset.equipmentFilter); }));
  document.querySelectorAll('#dashboard-view a[href="#equipment"]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    if (state) openEquipmentFilter();
  }));
  $('empty-add').addEventListener('click', () => openEquipment());
  $('add-employee').addEventListener('click', () => openEmployee());
  $('empty-add-employee').addEventListener('click', () => openEmployee());
  $('equipment-form').addEventListener('submit', submitEquipment);
  $('employee-form').addEventListener('submit', submitEmployee);
  $('employee-division-filter').addEventListener('change', () => { if (state) renderEmployees(); });
  $('clear-employee-filter').addEventListener('click', () => { $('employee-division-filter').value = ''; renderEmployees(); });
  $('detail-edit').addEventListener('click', async () => { await ui.closeDialog($('detail-dialog')); openEquipment(detailId); });
  $('detail-archive').addEventListener('click', toggleArchived);
  $('dismiss-notice').addEventListener('click', () => show($('notice'), false));
  $('search').addEventListener('input', () => { if (state) renderEquipment(); });
  for (const id of ['employee-filter', 'condition-filter', 'archive-filter']) $(id).addEventListener('change', () => { if (state) renderEquipment(); });
  $('clear-filters').addEventListener('click', () => {
    $('search').value = '';
    $('employee-filter').value = '';
    $('condition-filter').value = '';
    $('archive-filter').value = 'active';
    renderEquipment();
  });
  $('export-csv').addEventListener('click', exportCsv);
  $('print-equipment').addEventListener('click', printList);
  $('download-save').addEventListener('click', downloadSave);
  $('backup-file').addEventListener('change', previewFile);
  $('restore-save').addEventListener('click', restoreSave);
  $('cancel-preview').addEventListener('click', clearPreview);
  $('office-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('office-form').querySelector('[type="submit"]');
    if (button.disabled) return;
    const officeName = $('office-name').value.trim();
    if (!officeName) { notify('Enter an office name.', true); return; }
    busy(button, true, 'Saving…');
    try { await request('/api/settings', 'PUT', { officeName }); await reloadState(); notify('Office name saved.'); }
    catch (error) { notify(error.message, true); }
    finally { busy(button, false); }
  });
  window.addEventListener('hashchange', navigate);
  updateClock();
  setInterval(updateClock, 30000);
  try {
    const lastSave = localStorage.getItem('office-inventory-last-download');
    if (lastSave) $('last-saved').textContent = dateText(lastSave);
  } catch { /* Browser storage is optional. */ }
  reloadState().catch((error) => {
    $('loading').replaceChildren(element('p', error.message), actionButton('Try again', () => {
      reloadState().catch((retryError) => notify(retryError.message, true));
    }));
  });
})();
