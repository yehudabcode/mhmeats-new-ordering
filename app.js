// ══════════════════════════════════════════════════════════════════
// MH MEATS NEW ORDERING TOOL — staff app
// Orders live in the Google Sheet. This page keeps a copy on screen,
// saves every change straight away, and refreshes every 30 seconds.
// ══════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const CFG = window.MH_CONFIG || {};
  const R = window.MHRules;
  const API = window.MHApi;
  const POLL_MS = 30000;
  const LS_PIN = 'mhnew_pin', LS_PENDING = 'mhnew_pending', LS_SEEN = 'mhnew_seen_sub';
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  const S = {
    pin: '', role: '', managerPin: '',
    catalogue: { customers: [] },
    orders: {},          // date → cust → pid → {qty, note}
    custNotes: {},       // date → cust → note (from portal)
    submissions: [],     // newest first
    lastSubTs: '', seenTs: '', writes: 0,
    weekStart: '',       // Monday yyyy-mm-dd
    date: '',            // selected date
    cust: null,          // selected customer id
    panel: 'order',
    pending: {},         // key → {date, cust, pid, qty, note, seq}
    failed: {},          // key → error message
    seq: 0,
    unseen: 0,
    lastSync: null,
    syncing: false,
    pollTimer: null, flushTimer: null, retryDelay: 0,
    online: true, error: '',
  };

  // ── Small helpers ────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const mondayOf = s => { const d = parse(s); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return ymd(d); };
  const todayStr = () => ymd(new Date());
  const weekDates = () => DAY_NAMES.map((_, i) => addDays(S.weekStart, i));
  const dayName = s => parse(s).toLocaleDateString('en-GB', { weekday: 'long' });
  const niceDate = s => parse(s).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const shortDate = s => parse(s).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  const fmtQty = q => (Math.round(Number(q) * 100) / 100).toString();
  const custById = id => S.catalogue.customers.find(c => c.id === id);
  const keyOf = (date, cust, pid) => date + '|' + cust + '|' + pid;

  function defaultDate() {
    const t = new Date(); const dow = t.getDay();
    if (dow === 6) t.setDate(t.getDate() + 2);
    if (dow === 0) t.setDate(t.getDate() + 1);
    return ymd(t);
  }

  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = (bad ? '✗ ' : '✓ ') + msg;
    t.className = 'toast show' + (bad ? ' err' : '');
    clearTimeout(t._h); t._h = setTimeout(() => { t.className = 'toast' + (bad ? ' err' : ''); }, bad ? 6000 : 2500);
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [440, 550, 660].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination); o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3);
        o.start(ctx.currentTime + i * 0.15); o.stop(ctx.currentTime + i * 0.15 + 0.3);
      });
    } catch (e) {}
  }

  // Ask for a PIN in a small pop-up (returns a Promise<string|null>)
  function askPin(title, text) {
    return new Promise(resolve => {
      $('modalRoot').innerHTML = `<div class="modal-back"><div class="modal">
        <h3>${esc(title)}</h3><div class="muted" style="font-size:13px;margin-bottom:10px">${esc(text)}</div>
        <input type="password" inputmode="numeric" class="field pin-input" id="modalPin" maxlength="8" autocomplete="off">
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
          <button class="btn btn-ghost" id="modalCancel">Cancel</button><button class="btn btn-primary" id="modalOk">OK</button></div></div></div>`;
      const done = v => { $('modalRoot').innerHTML = ''; resolve(v); };
      $('modalCancel').onclick = () => done(null);
      $('modalOk').onclick = () => done($('modalPin').value.trim());
      $('modalPin').onkeydown = e => { if (e.key === 'Enter') done($('modalPin').value.trim()); if (e.key === 'Escape') done(null); };
      $('modalPin').focus();
    });
  }

  async function managerPin() {
    if (S.role === 'manager') return S.pin;
    if (S.managerPin) return S.managerPin;
    const p = await askPin('Manager PIN', 'This action needs the manager PIN.');
    if (!p) return null;
    try { const r = await API.call('login', { pin: p }, { retries: 1 }); if (r.role !== 'manager') throw new Error('That is not the manager PIN'); }
    catch (e) { toast(e.message, true); return null; }
    S.managerPin = p;
    return p;
  }

  // ── Status bar ───────────────────────────────────────────────────
  function renderStatus() {
    const b = $('statusBadge');
    const nPending = Object.keys(S.pending).length, nFailed = Object.keys(S.failed).length;
    if (!S.online) { b.className = 'badge status bad'; b.textContent = 'OFFLINE' + (nPending ? ' — ' + nPending + ' change(s) NOT saved yet' : ''); }
    else if (nFailed) { b.className = 'badge status bad'; b.textContent = nFailed + ' change(s) rejected'; }
    else if (nPending || S.syncing) { b.className = 'badge status busy'; b.textContent = nPending ? 'Saving ' + nPending + '…' : 'Refreshing…'; }
    else { b.className = 'badge status ok'; b.textContent = 'Live — all saved'; }
    $('syncInfo').textContent = S.lastSync ? 'Last refreshed ' + S.lastSync.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const gb = $('globalBanner');
    if (!S.online) gb.innerHTML = `<div class="banner bad">⚠ No connection to the Google Sheet: ${esc(S.error)}. Changes are kept on this PC and will save automatically when the connection returns. Do not close this page until the status says “all saved”.</div>`;
    else if (nFailed) gb.innerHTML = `<div class="banner bad">⚠ Some changes were rejected by the server: ${esc(Object.values(S.failed)[0])}</div>`;
    else gb.innerHTML = '';
  }

  window.addEventListener('beforeunload', e => {
    if (Object.keys(S.pending).length) { e.preventDefault(); e.returnValue = 'Some changes are not saved yet.'; return e.returnValue; }
  });

  // ── Login ────────────────────────────────────────────────────────
  async function login(auto) {
    const pin = auto ? lsGet(LS_PIN) : $('pinInput').value.trim();
    if (!pin) return;
    $('loginMsg').textContent = 'Connecting…';
    $('loginBtn').disabled = true;
    try {
      const r = await API.call('login', { pin: pin }, { retries: 1 });
      S.pin = pin; S.role = r.role;
      if (!auto && $('rememberPin').checked) lsSet(LS_PIN, pin);
      await start();
    } catch (e) {
      if (e.auth && auto) lsSet(LS_PIN, null);
      $('loginMsg').textContent = e.message;
      $('pinInput').focus();
    } finally { $('loginBtn').disabled = false; }
  }

  function logout() {
    if (Object.keys(S.pending).length && !confirm('Some changes are not saved yet. Lock anyway? (They stay on this PC and save next time.)')) return;
    lsSet(LS_PIN, null);
    location.reload();
  }

  async function start() {
    $('loginMsg').textContent = 'Loading catalogue…';
    const c = await API.call('getCatalogue', { pin: S.pin });
    S.catalogue = c.catalogue;
    S.date = defaultDate();
    S.weekStart = mondayOf(S.date);
    S.seenTs = lsGet(LS_SEEN) || '';
    try { S.pending = JSON.parse(lsGet(LS_PENDING) || '{}') || {}; } catch (e) { S.pending = {}; }
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');
    if (!S.catalogue.customers.length) { switchPanel('admin'); }
    buildNav();
    await refresh(true);
    if (Object.keys(S.pending).length) { toast('Saving ' + Object.keys(S.pending).length + ' change(s) left from last time'); scheduleFlush(0); }
    if (S.catalogue.customers.length && !S.cust) selectCustomer(S.catalogue.customers[0].id);
    S.pollTimer = setInterval(() => refresh(false), POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  }

  // ── Loading orders from the sheet ────────────────────────────────
  async function refresh(first) {
    if (S.syncing) return;
    S.syncing = true; renderStatus();
    const from = addDays(S.weekStart, 0), to = addDays(S.weekStart, 4), week = S.weekStart;
    const writesAtStart = S.writes;
    try {
      const r = await API.call('getOrders', { pin: S.pin, from: from, to: to, since: first ? '' : S.lastSubTs }, { retries: first ? 2 : 0 });
      if (S.writes === writesAtStart && !flushing && week === S.weekStart) {
        weekDates().forEach(d => { S.orders[d] = r.orders[d] || {}; S.custNotes[d] = (r.custNotes && r.custNotes[d]) || {}; });
        overlayPending();
      } else { setTimeout(() => refresh(false), 1500); }   // a save finished meanwhile — this copy may be older, fetch again
      handleSubmissions(r.submissions || [], first);
      S.online = true; S.error = ''; S.lastSync = new Date();
    } catch (e) {
      if (e.auth) return authLost(e);
      S.online = false; S.error = e.message;
    } finally {
      S.syncing = false;
      renderAll(!!first);
    }
  }

  // Customer submissions: keep a list, count the ones nobody has looked at, ring on new ones.
  function handleSubmissions(list, first) {
    let fresh;
    if (first) {
      S.submissions = list;
      fresh = S.seenTs ? list.filter(s => s.timestamp > S.seenTs) : [];
    } else {
      const known = new Set(S.submissions.map(s => s.submissionId));
      fresh = list.filter(s => !known.has(s.submissionId));
      S.submissions = fresh.concat(S.submissions).slice(0, 200);
    }
    if (S.submissions.length) S.lastSubTs = S.submissions[0].timestamp;
    if (!S.seenTs && first) { S.seenTs = S.lastSubTs; lsSet(LS_SEEN, S.seenTs); }
    if (fresh.length) {
      S.unseen += fresh.length;
      const names = [...new Set(fresh.map(s => (custById(s.customer) || { name: s.customer }).name))].join(', ');
      toast('New order from ' + names);
      beep();
      if (S.panel === 'incoming') { S.unseen = 0; markSeen(); renderIncoming(); }
    }
    const dot = $('incomingDot');
    dot.textContent = S.unseen; dot.classList.toggle('hidden', !S.unseen);
  }
  function markSeen() { S.seenTs = S.lastSubTs; lsSet(LS_SEEN, S.seenTs); }

  function authLost(e) {
    clearInterval(S.pollTimer);
    lsSet(LS_PIN, null);
    alert('Your PIN is no longer accepted (' + e.message + '). Please enter it again. Unsaved changes stay on this PC.');
    location.reload();
  }

  function overlayPending() {
    Object.values(S.pending).forEach(p => {
      const day = S.orders[p.date] = S.orders[p.date] || {};
      const c = day[p.cust] = day[p.cust] || {};
      if (p.qty > 0 || p.note) c[p.pid] = { qty: p.qty, note: p.note };
      else delete c[p.pid];
    });
  }

  // ── Saving changes ───────────────────────────────────────────────
  function lineOf(date, cust, pid) { return ((S.orders[date] || {})[cust] || {})[pid] || { qty: 0, note: '' }; }

  function setLine(date, cust, pid, qty, note) {
    const k = keyOf(date, cust, pid);
    S.pending[k] = { date, cust, pid, qty, note, seq: ++S.seq };
    delete S.failed[k];
    lsSet(LS_PENDING, JSON.stringify(S.pending));
    overlayPending();
    scheduleFlush(600);
    renderStatus();
  }

  function scheduleFlush(ms) {
    clearTimeout(S.flushTimer);
    S.flushTimer = setTimeout(flush, ms);
  }

  let flushing = false;
  async function flush() {
    if (flushing) return scheduleFlush(300);
    const items = Object.entries(S.pending);
    if (!items.length) return;
    flushing = true;
    const groups = {};
    items.forEach(([k, p]) => { const g = p.date + '|' + p.cust; (groups[g] = groups[g] || []).push([k, p]); });
    let anyNetErr = null;
    for (const g of Object.values(groups)) {
      const { date, cust } = g[0][1];
      const sent = g.map(([k, p]) => [k, p.seq]);
      try {
        const r = await API.call('setLines', { pin: S.pin, date, customer: cust, by: S.role, changes: g.map(([, p]) => ({ productId: p.pid, qty: p.qty, note: p.note })) }, { retries: 1 });
        sent.forEach(([k, seq]) => { if (S.pending[k] && S.pending[k].seq === seq) delete S.pending[k]; });
        (S.orders[date] = S.orders[date] || {})[cust] = r.lines || {};
        S.writes++;
        S.online = true; S.error = '';
      } catch (e) {
        if (e.auth) { flushing = false; return authLost(e); }
        if (e.server) {   // the server refused these lines — they will never save as they are
          sent.forEach(([k]) => { S.failed[k] = e.message; delete S.pending[k]; });
          toast('Not saved: ' + e.message, true);
        } else { anyNetErr = e; }
      }
    }
    lsSet(LS_PENDING, Object.keys(S.pending).length ? JSON.stringify(S.pending) : null);
    overlayPending();
    flushing = false;
    if (anyNetErr) {
      S.online = false; S.error = anyNetErr.message;
      S.retryDelay = Math.min((S.retryDelay || 2500) * 2, 60000);
      scheduleFlush(S.retryDelay);
    } else { S.retryDelay = 0; if (Object.keys(S.pending).length) scheduleFlush(300); }
    renderAll(false);
  }

  // ── Navigation ───────────────────────────────────────────────────
  function buildNav() {
    document.querySelectorAll('#nav .nav-tab').forEach(t => { t.onclick = () => switchPanel(t.dataset.panel); });
    $('buildBadge').textContent = 'v' + (CFG.BUILD || '');
  }

  function switchPanel(name) {
    S.panel = name;
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    document.querySelectorAll('#nav .nav-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
    if (name === 'incoming') { S.unseen = 0; $('incomingDot').classList.add('hidden'); markSeen(); }
    $('weekbar').classList.toggle('hidden', name === 'links' || name === 'admin' || name === 'incoming');
    renderAll(true);
  }

  function selectDate(d) {
    S.date = d;
    const ws = mondayOf(d);
    if (ws !== S.weekStart) { S.weekStart = ws; renderAll(true); refresh(false); }
    else renderAll(true);
  }
  function shiftWeek(n) { selectDate(addDays(S.weekStart, 7 * n)); }
  function goToday() { selectDate(defaultDate()); }

  // ── Rendering ────────────────────────────────────────────────────
  function renderAll(full) {
    $('todayBadge').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    renderStatus();
    if (!S.date) return;
    renderWeekbar();
    const p = S.panel;
    if (p === 'order') { renderCustomerList(); renderDaySummary(); if (full) renderProducts(); else refreshProductValues(); }
    if (p === 'summary') renderSummary();
    if (p === 'chef') renderChef();
    if (p === 'butcher') renderButcher();
    if (p === 'packer') renderPacker();
    if (p === 'dispatch') renderDispatch();
    if (p === 'incoming' && full) renderIncoming();
    if (p === 'links' && full) renderLinks();
    if (p === 'admin' && full) renderAdmin();
  }

  function dayOrders(d) { return S.orders[d || S.date] || {}; }
  function totalLines(d) { return S.catalogue.customers.reduce((a, c) => a + R.countLines(S.catalogue, dayOrders(d), c.id), 0); }

  function renderWeekbar() {
    $('weekLabel').textContent = 'Week of ' + parse(S.weekStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const t = todayStr();
    $('dayBtns').innerHTML = weekDates().map(d => {
      const n = totalLines(d);
      return `<button class="day-btn${d === S.date ? ' active' : ''}${d === t ? ' today' : ''}" data-date="${d}">${dayName(d).slice(0, 3).toUpperCase()} <span class="cnt">${n ? '(' + n + ')' : ''}</span><small>${parse(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</small></button>`;
    }).join('');
    $('dayBtns').querySelectorAll('.day-btn').forEach(b => { b.onclick = () => selectDate(b.dataset.date); });
  }

  function renderCustomerList() {
    $('customerList').innerHTML = S.catalogue.customers.map(c => {
      const n = R.countLines(S.catalogue, dayOrders(), c.id);
      const hasNote = (S.custNotes[S.date] || {})[c.id];
      return `<button class="customer-btn${c.id === S.cust ? ' active' : ''}" data-id="${esc(c.id)}">
        <span class="customer-dot" style="background:${esc(c.color)}"></span>
        <span class="customer-name">${esc(c.name)}${c.bulk ? ' <span class="muted" style="font-size:10px">BULK</span>' : ''}${hasNote ? ' 📝' : ''}</span>
        <span class="customer-count${n ? '' : ' zero'}">${n}</span></button>`;
    }).join('') || '<div class="muted">No customers yet — load the catalogue in Admin.</div>';
    $('customerList').querySelectorAll('.customer-btn').forEach(b => { b.onclick = () => selectCustomer(b.dataset.id); });
  }

  function renderDaySummary() {
    const lines = S.catalogue.customers.map(c => [c, R.countLines(S.catalogue, dayOrders(), c.id)]).filter(x => x[1]);
    const total = lines.reduce((a, x) => a + x[1], 0);
    $('daySummary').innerHTML = `<div style="margin-bottom:6px;color:var(--text);font-weight:600">${esc(niceDate(S.date))}</div>` + (total
      ? lines.map(([c, n]) => `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border)"><span>${esc(c.name)}</span><span class="mono" style="color:var(--accent)">${n} items</span></div>`).join('') +
        `<div style="padding-top:6px;font-weight:600;color:var(--accent)">Total: ${total} line items</div>`
      : '<span class="muted">No orders entered yet for this day.</span>');
  }

  function selectCustomer(id) { S.cust = id; if (S.panel !== 'order') switchPanel('order'); else renderAll(true); }

  const SECTION_DEFS = {
    chef: [['chef-beef', '🥩 BEEF — MH Meats Chef', 'badge-beef', 'BEEF'], ['chef-chicken', '🐔 CHICKEN — MH Meats Chef', 'badge-flavoured', 'CHICKEN'], ['chef-lamb', '🐑 LAMB — MH Meats Chef', 'badge-poultry', 'LAMB']],
    std: [['beef', '🥩 {name} — Beef', 'badge-beef', 'BEEF'], ['poultry', '🐔 {name} — Poultry', 'badge-poultry', 'POULTRY'], ['flavoured', '🌶 Flavoured Products', 'badge-flavoured', 'FLAVOURED']],
  };

  function renderProducts() {
    const area = $('productArea');
    const cust = custById(S.cust);
    if (!cust) { area.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div>Select a customer to start entering orders</div></div>'; return; }
    const hadFocus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.pid : null;
    const defs = cust.products.some(p => p.cat.indexOf('chef-') === 0) ? SECTION_DEFS.chef : SECTION_DEFS.std;
    let html = `<div class="card"><div class="card-body" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span class="customer-dot" style="background:${esc(cust.color)};width:12px;height:12px"></span>
      <strong class="cond" style="font-size:18px;letter-spacing:.5px">${esc(cust.name.toUpperCase())}</strong>
      <span class="muted">— ${esc(niceDate(S.date))}</span>
      <span class="muted" style="margin-left:auto;font-size:12px">Changes save automatically. Enter or ↓ moves to the next box.</span></div></div>`;
    const cn = (S.custNotes[S.date] || {})[cust.id];
    if (cn) html += `<div class="banner warn">📝 Customer's note for this order: <strong>${esc(cn)}</strong></div>`;
    const orphans = R.customerLines(cust, dayOrders()).filter(l => l.orphan);
    if (orphans.length) html += `<div class="banner bad">⚠ This order contains ${orphans.length} product(s) that are no longer in the catalogue: ${orphans.map(o => esc(o.product.name) + ' × ' + fmtQty(o.qty)).join(', ')}. They still show on the production sheets.</div>`;
    defs.forEach(([cat, title, badge, label]) => {
      const prods = cust.products.filter(p => p.cat === cat);
      if (!prods.length) return;
      const count = prods.filter(p => lineOf(S.date, cust.id, p.id).qty > 0).length;
      html += `<div class="card"><div class="card-header">${esc(title.replace('{name}', cust.name))} <span class="section-badge ${badge}">${label}</span>
        <span class="mono" style="margin-left:auto;color:var(--accent)">${count ? count + ' items' : ''}</span></div>
        <div class="card-body" style="padding:8px"><div class="product-grid">${prods.map(p => productRow(cust, p)).join('')}</div></div></div>`;
    });
    area.innerHTML = html;
    area.querySelectorAll('.qty-input').forEach(inp => {
      inp.onchange = () => onQty(inp);
      inp.onkeydown = e => arrowNav(e, inp);
      inp.onfocus = () => inp.select();
    });
    area.querySelectorAll('.note-input').forEach(inp => { inp.onchange = () => onNote(inp); });
    if (hadFocus) { const el = area.querySelector(`.qty-input[data-pid="${CSS.escape(hadFocus)}"]`); if (el) el.focus(); }
  }

  function rowClass(cust, p) {
    const k = keyOf(S.date, cust.id, p.id);
    const l = lineOf(S.date, cust.id, p.id);
    return 'product-row' + (l.qty > 0 ? ' has-qty' : '') + (S.pending[k] ? ' pending' : '') + (S.failed[k] ? ' failed' : '');
  }

  function productRow(cust, p) {
    const l = lineOf(S.date, cust.id, p.id);
    const unit = p.cat === 'beef' && p.unit ? `<span class="unit-lbl${p.unit === 'KG' ? ' kg' : ''}">${esc(p.unit)}</span>` : '';
    const tags = (p.staffOnly ? '<span class="tag" title="Not on the customer\'s portal">STAFF</span>' : '') + (p.produceAs ? `<span class="tag">→ ${esc(p.produceAs)}</span>` : '');
    return `<div class="${rowClass(cust, p)}" id="row-${esc(p.id)}" title="${esc(S.failed[keyOf(S.date, cust.id, p.id)] || '')}">
      <div class="product-name-wrap"><div class="product-name">${esc(p.name)}${tags}</div>
      <input type="text" class="note-input" data-pid="${esc(p.id)}" placeholder="add note…" value="${esc(l.note)}" maxlength="300"></div>
      ${unit}
      <input type="number" class="qty-input" data-pid="${esc(p.id)}" min="0" step="any" inputmode="decimal" placeholder="0" value="${l.qty > 0 ? fmtQty(l.qty) : ''}">
    </div>`;
  }

  // Update values in place (after a refresh) without disturbing the box being typed in
  function refreshProductValues() {
    const cust = custById(S.cust);
    if (!cust || !$('productArea').querySelector('.qty-input')) return renderProducts();
    cust.products.forEach(p => {
      const row = $('row-' + p.id); if (!row) return;
      const l = lineOf(S.date, cust.id, p.id);
      row.className = rowClass(cust, p);
      const q = row.querySelector('.qty-input'), n = row.querySelector('.note-input');
      if (q && q !== document.activeElement) q.value = l.qty > 0 ? fmtQty(l.qty) : '';
      if (n && n !== document.activeElement) n.value = l.note || '';
    });
  }

  function onQty(inp) {
    const pid = inp.dataset.pid;
    let v = inp.value.trim() === '' ? 0 : Number(inp.value);
    if (!isFinite(v) || v < 0) { toast('Quantity must be a number of 0 or more', true); v = 0; inp.value = ''; }
    const l = lineOf(S.date, S.cust, pid);
    if (v === l.qty) return;
    setLine(S.date, S.cust, pid, v, l.note || '');
    const cust = custById(S.cust), p = cust.products.find(x => x.id === pid);
    $('row-' + pid).className = rowClass(cust, p);
    renderCustomerList(); renderDaySummary(); renderWeekbar();
  }
  function onNote(inp) {
    const pid = inp.dataset.pid;
    const l = lineOf(S.date, S.cust, pid);
    const note = inp.value.trim();
    if (note === (l.note || '')) return;
    setLine(S.date, S.cust, pid, l.qty, note);
    const cust = custById(S.cust); $('row-' + pid).className = rowClass(cust, cust.products.find(x => x.id === pid));
  }
  function arrowNav(e, inp) {
    const all = Array.from(document.querySelectorAll('#productArea .qty-input'));
    const i = all.indexOf(inp);
    if ((e.key === 'ArrowDown' || e.key === 'Enter') && i < all.length - 1) { e.preventDefault(); inp.blur(); all[i + 1].focus(); }
    if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); inp.blur(); all[i - 1].focus(); }
  }

  // ── Summary ──────────────────────────────────────────────────────
  function renderSummary() {
    const t = todayStr();
    const cards = weekDates().map(d => {
      const n = totalLines(d);
      const cs = S.catalogue.customers.filter(c => R.countLines(S.catalogue, dayOrders(d), c.id)).length;
      return `<div class="summary-card${d === S.date ? ' sel' : ''}" data-date="${d}"><div class="summary-label">${esc(dayName(d))} ${parse(d).getDate()}${d === t ? ' ★' : ''}</div>
        <div class="summary-value">${n}</div><div class="summary-sub">${cs} customer${cs === 1 ? '' : 's'}</div></div>`;
    }).join('');
    const rows = S.catalogue.customers.map(c => {
      const lines = R.customerLines(c, dayOrders());
      if (!lines.length) return '';
      const grp = (label, color, ls) => ls.length ? `<div style="margin-top:6px"><div style="font-size:10px;font-weight:700;color:${color};margin-bottom:3px">${label}</div><div style="display:flex;flex-wrap:wrap;gap:3px">${ls.map(l => `<span style="font-size:11px;background:var(--surface2);border-radius:3px;padding:2px 6px">${esc(l.product.name)}: <strong style="color:var(--accent)">${fmtQty(l.qty)}</strong></span>`).join('')}</div></div>` : '';
      return `<tr><td style="white-space:nowrap"><span class="customer-dot" style="display:inline-block;background:${esc(c.color)};margin-right:8px"></span>${esc(c.name)}</td>
        <td class="td-qty">${lines.length}</td>
        <td>${grp('🐔 Poultry', 'var(--success)', lines.filter(l => !R.isBeef(l.product) && !R.isFlav(l.product)))}${grp('🌶 Flavoured', '#e08020', lines.filter(l => !R.isBeef(l.product) && R.isFlav(l.product)))}${grp('🥩 Beef', '#eb5757', lines.filter(l => R.isBeef(l.product)))}</td></tr>`;
    }).join('');
    $('summaryContent').innerHTML = `<div class="summary-grid">${cards}</div>
      <div class="sheet-table"><div class="sheet-title-bar"><div class="sheet-title">${esc(niceDate(S.date))} — customer breakdown</div></div>
      ${rows ? `<table><thead><tr><th>Customer</th><th style="text-align:right">Lines</th><th>Items</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty-state"><div class="empty-icon">📋</div><div>No orders for this day</div></div>'}</div>`;
    $('summaryContent').querySelectorAll('.summary-card').forEach(c => { c.onclick = () => selectDate(c.dataset.date); });
  }

  // ── Production sheets (HTML builders reused for printing) ────────
  const tagList = srcs => srcs.map(s => `<span class="cat-tag">${esc(s.short)}:${fmtQty(s.qty)}</span>`).join('');
  const noteList = srcs => { const n = srcs.filter(s => s.note).map(s => esc(s.short) + ': ' + esc(s.note)).join(' | '); return n ? `<span class="note">📝 ${n}</span>` : ''; };

  function titleBar(title, right, extra) {
    return `<div class="sheet-title-bar"><div class="sheet-title">${esc(title)}</div><div class="mono muted" style="margin-left:auto;font-size:11px">${esc(right || '')}</div>${extra || ''}</div>`;
  }

  function categoryTable(title, items, roasters, section) {
    const total = items.reduce((a, b) => a + b.qty, 0);
    const rows = items.map(i => `<tr><td class="td-qty${i.qty ? '' : ' td-zero'}">${fmtQty(i.qty)}</td><td class="td-unit">${esc(i.unit || '')}</td>
      <td>${esc(i.name)}${i.orderedAs ? `<span class="desc">(ordered as ${esc(i.orderedAs)})</span>` : ''}${i.desc ? `<span class="desc">${esc(i.desc)}</span>` : ''}${i.note ? `<span class="note">📝 ${esc(i.note)}</span>` : ''}</td><td class="td-check">☐</td></tr>`).join('');
    const tot = roasters !== undefined
      ? `<tr class="total-row"><td colspan="4">TOTAL ${esc(title)} = ${fmtQty(total)} &nbsp;|&nbsp; TOTAL ROASTERS NEEDED = ${fmtQty(roasters)}</td></tr>`
      : `<tr class="total-row"><td colspan="4">TOTAL = ${fmtQty(total)}</td></tr>`;
    return `<div class="sheet-table" data-section="${section}">${titleBar(title, niceDate(S.date).toUpperCase())}
      <table><thead><tr><th style="text-align:right">AMT</th><th>UNIT</th><th>PRODUCT</th><th>✓</th></tr></thead><tbody>${rows}${tot}</tbody></table></div>`;
  }

  const empty = (icon, txt) => `<div class="empty-state"><div class="empty-icon">${icon}</div><div>${esc(txt)}</div></div>`;

  function chefHtml() {
    const items = R.chef(S.catalogue, dayOrders());
    if (!items.length) return empty('🌶', 'No chef / flavoured orders for ' + niceDate(S.date));
    const total = items.reduce((a, b) => a + b.qty, 0);
    const rows = items.map(i => `<tr class="${i.qty > 10 ? 'row-highlight' : ''}"><td>${esc(i.name)} ${tagList(i.sources)}${noteList(i.sources)}</td><td class="td-qty">${fmtQty(i.qty)}</td><td class="td-check">☐</td></tr>`).join('');
    return `<div class="summary-grid no-print"><div class="summary-card"><div class="summary-label">Chef lines</div><div class="summary-value">${items.length}</div></div>
      <div class="summary-card"><div class="summary-label">Total units</div><div class="summary-value">${fmtQty(total)}</div></div></div>
      <div class="sheet-table" data-section="chef">${titleBar('🌶 CHEF — FLAVOURED & MH MEATS CHEF — ' + dayName(S.date).toUpperCase(), items.length + ' lines')}
      <table><thead><tr><th>PRODUCT</th><th style="text-align:right">QTY</th><th>✓</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function bulkButtons(sheet, cust) { return `<button class="btn btn-primary no-print" style="margin-left:8px" data-print-bulk="${sheet}|${esc(cust.id)}">🖨 Print ${esc(cust.name)}</button>`; }

  function butcherHtml() {
    const b = R.butcher(S.catalogue, dayOrders());
    let html = '';
    b.poultry.forEach(g => { html += categoryTable(g.cat, g.items, g.roasters, 'poultry'); });
    if (b.otherPoultry.length) html += categoryTable('OTHER POULTRY (not in a butcher group)', b.otherPoultry, undefined, 'poultry');
    if (!b.poultry.length && !b.otherPoultry.length) html += `<div class="banner warn" data-section="poultry">No retail poultry for ${esc(niceDate(S.date))}.</div>`;
    b.beef.forEach(g => { html += categoryTable(g.cat, g.items, undefined, 'beef'); });
    if (b.bulk.length) {
      html += `<div class="bulk-heading" data-section="bulk">⚡ BULK / CATERER ORDERS</div>`;
      b.bulk.forEach(x => {
        html += `<div data-section="bulk" data-bulk="${esc(x.cust.id)}"><div style="display:flex;align-items:center;margin:6px 0"><strong style="color:${esc(x.cust.color === '#ffffff' ? '#aaa' : x.cust.color)}">⚡ BULK — ${esc(x.cust.name.toUpperCase())}</strong>${bulkButtons('butcher', x.cust)}</div>`;
        if (x.poultry.length) html += categoryTable('🐔 ' + x.cust.name + ' — POULTRY', x.poultry, undefined, 'bulk');
        if (x.beef.length) html += categoryTable('🥩 ' + x.cust.name + ' — BEEF', x.beef, undefined, 'bulk');
        html += '</div>';
      });
    }
    return html;
  }

  function packerTable(title, items, withUnit, section) {
    const rows = items.map(i => `<tr><td>${esc(i.name)} ${tagList(i.sources)}${noteList(i.sources)}</td>${withUnit ? `<td class="td-unit" style="text-align:center">${esc(i.unit)}</td>` : ''}<td class="td-qty">${fmtQty(i.qty)}</td><td class="td-check">☐</td></tr>`).join('');
    const total = items.reduce((a, b) => a + b.qty, 0);
    return `<div class="sheet-table" data-section="${section}">${titleBar(title, items.length + ' lines' + (withUnit ? '' : ' / ' + fmtQty(total) + ' total'))}
      <table><thead><tr><th>PRODUCT</th>${withUnit ? '<th style="text-align:center">UNIT</th>' : ''}<th style="text-align:right">${withUnit ? 'PACKS' : 'QTY'}</th><th>✓</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function bulkLinesTable(x, sheet) {
    const row = (icon, i) => `<tr><td>${icon} ${esc(i.name)}${i.orderedAs ? `<span class="desc">(ordered as ${esc(i.orderedAs)})</span>` : ''}${i.note ? `<span class="note">📝 ${esc(i.note)}</span>` : ''}</td><td class="td-unit" style="text-align:center">${esc(i.unit)}</td><td class="td-qty">${fmtQty(i.qty)}</td><td class="td-check">☐</td></tr>`;
    const rows = x.poultry.map(i => row('🐔', i)).join('') + (x.flavoured || []).map(i => row('🌶', i)).join('') + x.beef.map(i => row('🥩', i)).join('');
    const n = x.poultry.length + (x.flavoured || []).length + x.beef.length;
    return `<div class="sheet-table" data-section="bulk" data-bulk="${esc(x.cust.id)}" style="border-left:3px solid ${esc(x.cust.color === '#ffffff' ? '#aaa' : x.cust.color)}">
      ${titleBar('📦 BULK — ' + x.cust.name.toUpperCase(), n + ' lines', bulkButtons(sheet, x.cust))}
      <table><thead><tr><th>PRODUCT</th><th style="text-align:center">UNIT</th><th style="text-align:right">QTY</th><th>✓</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function packerHtml() {
    const p = R.packer(S.catalogue, dayOrders());
    if (!p.poultry.length && !p.beef.length && !p.bulk.length) return empty('📦', 'No orders for ' + niceDate(S.date));
    let html = '';
    const dn = dayName(S.date).toUpperCase();
    if (p.poultry.length) html += packerTable('📦 POULTRY PACKER LIST — ' + dn, p.poultry, false, 'poultry');
    // Flavoured products excluded from packer — Chef sheet only
    if (p.beef.length) html += packerTable('🥩 BEEF PACKER LIST — ' + dn, p.beef, true, 'beef');
    if (p.bulk.length) { html += `<div class="bulk-heading" data-section="bulk">⚡ BULK / CATERER ORDERS</div>`; p.bulk.forEach(x => { html += bulkLinesTable(x, 'packer'); }); }
    return html;
  }

  function dispatchCard(d) {
    const sec = (title, color, items) => items.length ? `<div style="margin-bottom:8px"><div style="font-size:11px;font-weight:700;color:${color};margin-bottom:4px">${title}</div><table>${items.map(i =>
      `<tr><td style="padding:4px 8px">${esc(i.name)}${i.producedAs ? `<span class="desc">(= ${esc(i.producedAs)})</span>` : ''}${i.note ? `<span class="note">📝 ${esc(i.note)}</span>` : ''}</td><td class="td-unit">${esc(i.unit)}</td><td class="td-qty" style="padding:4px 8px">${fmtQty(i.qty)}</td><td class="td-check">☐</td></tr>`).join('')}</table></div>` : '';
    const n = d.poultry.length + d.flavoured.length + d.beef.length;
    const cn = (S.custNotes[S.date] || {})[d.cust.id];
    return `<div class="sheet-table" data-section="dispatch" data-cust="${esc(d.cust.id)}" style="padding:0 0 4px">
      ${titleBar('🚚 ' + d.cust.name.toUpperCase() + ' — ' + niceDate(S.date).toUpperCase(), n + ' lines', `<button class="btn btn-primary no-print" style="margin-left:8px" data-print-disp="${esc(d.cust.id)}">🖨 Print ${esc(d.cust.name)}</button>`)}
      <div style="padding:10px 12px">${cn ? `<div class="banner warn">📝 Customer note: ${esc(cn)}</div>` : ''}${sec('🐔 Poultry', 'var(--success)', d.poultry)}${sec('🌶 Flavoured', '#e08020', d.flavoured)}${sec('🥩 Beef', '#eb5757', d.beef)}</div></div>`;
  }

  function dispatchHtml() {
    const ds = R.dispatch(S.catalogue, dayOrders());
    return ds.length ? ds.map(dispatchCard).join('') : empty('🚚', 'No orders for ' + niceDate(S.date));
  }

  function wirePrintButtons(root) {
    root.querySelectorAll('[data-print-bulk]').forEach(b => { b.onclick = () => { const [sheet, id] = b.dataset.printBulk.split('|'); printBulkCustomer(sheet, id); }; });
    root.querySelectorAll('[data-print-disp]').forEach(b => { b.onclick = () => printDispatchCustomer(b.dataset.printDisp); });
  }
  function renderChef() { $('chefContent').innerHTML = chefHtml(); }
  function renderButcher() { $('butcherContent').innerHTML = butcherHtml(); wirePrintButtons($('butcherContent')); }
  function renderPacker() { $('packerContent').innerHTML = packerHtml(); wirePrintButtons($('packerContent')); }
  function renderDispatch() { $('dispatchContent').innerHTML = dispatchHtml(); wirePrintButtons($('dispatchContent')); }

  // ── Printing ─────────────────────────────────────────────────────
  const PRINT_CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:12px;color:#000;background:#fff;padding:18px}
    .ph{text-align:center;border-bottom:3px solid #000;padding-bottom:8px;margin-bottom:16px}.ph h1{font-size:20px;letter-spacing:2px}.ph h2{font-size:14px;font-weight:normal;margin-top:4px}
    .sheet-table{border:1px solid #999;margin-bottom:16px;page-break-inside:avoid}.sheet-title-bar{background:#ddd;padding:6px 10px;border-bottom:1px solid #999;display:flex;justify-content:space-between}
    .sheet-title{font-size:13px;font-weight:bold}table{width:100%;border-collapse:collapse}th{background:#eee;text-align:left;padding:5px 8px;font-size:10px;text-transform:uppercase;border:1px solid #aaa}
    td{padding:5px 8px;border:1px solid #ccc;font-size:12px}.td-qty{font-weight:bold;text-align:right;font-size:14px;width:60px}.td-zero{color:#bbb;font-weight:normal}.td-unit{font-size:10px;color:#555;width:50px}.td-check{text-align:center;width:28px}
    .desc{font-size:9px;color:#555;margin-left:6px}.note{display:block;font-size:10px;color:#9a6200}.cat-tag{display:inline-block;font-size:8px;border:1px solid #aaa;padding:0 3px;margin-left:3px}
    .total-row td{background:#f3f3f3;font-weight:bold}.no-print,.summary-grid,button{display:none!important}.bulk-heading{font-size:14px;font-weight:bold;margin:14px 0 8px;border-bottom:2px solid #000}
    .banner{border:1px solid #999;padding:6px;margin-bottom:8px}tr{page-break-inside:avoid}@page{margin:1.3cm;size:A4 portrait}`;

  function openPrint(title, sub, bodyHtml) {
    if (!bodyHtml || !bodyHtml.trim()) { toast('Nothing to print', true); return; }
    const w = window.open('', '_blank');
    if (!w) { toast('Pop-up blocked — allow pop-ups for this site to print', true); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>
      <div class="ph"><h1>MH MEATS — ${esc(title)}</h1><h2>${esc(sub)}</h2><div style="font-size:10px;color:#666;margin-top:3px">Printed ${esc(new Date().toLocaleString('en-GB'))}</div></div>${bodyHtml}</body></html>`);
    w.document.close();
    w.onafterprint = () => w.close();
    setTimeout(() => w.print(), 350);
  }

  function pick(html, sections) {
    const div = document.createElement('div'); div.innerHTML = html;
    if (!sections) return div.innerHTML;
    return Array.from(div.children).filter(el => sections.indexOf(el.dataset.section) >= 0).map(el => el.outerHTML).join('');
  }

  function print(sheet, part) {
    const sub = niceDate(S.date).toUpperCase();
    const want = part === 'all' ? null : [part];
    if (sheet === 'chef') return openPrint('CHEF SHEET', sub, pick(chefHtml(), null));
    if (sheet === 'butcher') return openPrint('BUTCHER LIST' + (want ? ' — ' + part.toUpperCase() : ''), sub, pick(butcherHtml(), want));
    if (sheet === 'packer') return openPrint('PACKER LIST' + (want ? ' — ' + part.toUpperCase() : ''), sub, pick(packerHtml(), want));
    if (sheet === 'dispatch') return openPrint('DISPATCH', sub, dispatchHtml());
  }
  function printBulkCustomer(sheet, id) {
    const html = sheet === 'butcher' ? butcherHtml() : packerHtml();
    const div = document.createElement('div'); div.innerHTML = html;
    const parts = Array.from(div.querySelectorAll(`[data-bulk="${CSS.escape(id)}"]`)).map(e => e.outerHTML).join('');
    openPrint((sheet === 'butcher' ? 'BUTCHER' : 'PACKER') + ' — ' + (custById(id) || {}).name, niceDate(S.date).toUpperCase(), parts);
  }
  function printDispatchCustomer(id) {
    const d = R.dispatch(S.catalogue, dayOrders()).find(x => x.cust.id === id);
    if (d) openPrint('DISPATCH — ' + d.cust.name.toUpperCase(), niceDate(S.date).toUpperCase(), dispatchCard(d));
  }

  // ── Incoming customer orders ─────────────────────────────────────
  function renderIncoming() {
    const list = S.submissions;
    if (!list.length) { $('incomingContent').innerHTML = empty('📥', 'No customer orders received yet'); return; }
    $('incomingContent').innerHTML = list.map((s, i) => {
      const c = custById(s.customer) || { name: s.customer, products: [] };
      const t = new Date(s.timestamp);
      const lines = Object.entries(s.lines || {}).map(([pid, q]) => { const p = (c.products || []).find(x => x.id === pid); return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0"><span>${esc(p ? p.name : pid)}</span><span class="mono" style="color:var(--accent)">× ${fmtQty(q)}</span></div>`; }).join('');
      return `<div class="incoming-item" data-i="${i}">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="customer-dot" style="background:${esc(c.color || '#888')}"></span><strong>${esc(c.name)}</strong>
        <span class="muted">for</span><strong style="color:var(--accent)">${esc(niceDate(s.date))}</strong>
        <span class="mono muted" style="margin-left:auto;font-size:11px">${esc(t.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))} · ${s.lineCount} lines</span>
        <button class="btn btn-ghost" data-open="${esc(s.date)}|${esc(s.customer)}">Open order →</button></div>
        ${s.note ? `<div class="note" style="margin:4px 0 0 19px">📝 ${esc(s.note)}</div>` : ''}
        <div class="hidden" style="margin:8px 0 0 19px;max-width:520px" data-lines>${lines || '<span class="muted">Customer cleared the order (0 lines).</span>'}</div></div>`;
    }).join('');
    $('incomingContent').querySelectorAll('.incoming-item').forEach(el => { el.onclick = e => { if (e.target.dataset.open) return; el.querySelector('[data-lines]').classList.toggle('hidden'); }; });
    $('incomingContent').querySelectorAll('[data-open]').forEach(b => { b.onclick = () => { const [d, c] = b.dataset.open.split('|'); S.cust = c; switchPanel('order'); selectDate(d); }; });
  }

  // ── Customer links ───────────────────────────────────────────────
  function portalLink(c) { return new URL('portal.html', location.href).href.split('?')[0] + '?c=' + encodeURIComponent(c.id) + '&k=' + encodeURIComponent(c.token || ''); }
  function renderLinks() {
    $('linksBody').innerHTML = S.catalogue.customers.map(c => {
      const link = portalLink(c);
      const wa = 'https://wa.me/?text=' + encodeURIComponent('Hi, here is your MH Meats order link for ' + c.name + ': ' + link);
      return `<tr><td><span class="customer-dot" style="display:inline-block;background:${esc(c.color)};margin-right:8px"></span><strong>${esc(c.name)}</strong></td>
        <td class="mono" style="font-size:10px;word-break:break-all;color:var(--muted)">${esc(link)}</td>
        <td style="text-align:center;white-space:nowrap"><button class="btn btn-ghost" data-copy="${esc(link)}">📋 Copy</button> <a class="btn btn-wa" href="${esc(wa)}" target="_blank" rel="noopener">💬 WhatsApp</a></td></tr>`;
    }).join('') || '<tr><td colspan="3" class="muted">No customers yet.</td></tr>';
    $('linksBody').querySelectorAll('[data-copy]').forEach(b => { b.onclick = () => copy(b.dataset.copy, 'Link copied'); });
  }
  function copy(text, msg) {
    const done = () => toast(msg);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallback());
    else fallback();
    function fallback() { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed', true); } t.remove(); }
  }
  function copyAllLinks() { copy(S.catalogue.customers.map(c => c.name + ':\n' + portalLink(c)).join('\n\n'), 'All links copied'); }

  // ── Clear day ────────────────────────────────────────────────────
  async function clearDay() {
    const n = totalLines(S.date);
    if (!n) return toast('Nothing to clear for ' + niceDate(S.date));
    if (!confirm(`Clear ALL ${n} order lines for ${niceDate(S.date)} for EVERY customer?\nThis affects every PC.`)) return;
    const pin = await managerPin(); if (!pin) return;
    try { const r = await API.call('clearDay', { pin, date: S.date }); toast('Cleared ' + r.cleared + ' lines'); await refresh(false); }
    catch (e) { toast(e.message, true); }
  }

  // ── Admin ────────────────────────────────────────────────────────
  let adminCat = null;
  async function renderAdmin() {
    const el = $('adminContent');
    if (!adminCat && (S.role === 'manager' || S.managerPin)) {
      el.innerHTML = '<div class="card"><div class="card-body muted">Loading admin…</div></div>';
      try { adminCat = (await API.call('adminCatalogue', { pin: await managerPin() })).catalogue; }
      catch (e) { el.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; return; }
    }
    if (!adminCat) {
      el.innerHTML = (!S.catalogue.customers.length ? '<div class="banner warn">The order book has no customers yet. A manager must log in and load the starting catalogue here.</div>' : '') + `<div class="card"><div class="card-header">⚙️ Admin</div><div class="card-body">
        <div class="muted" style="margin-bottom:10px">Manager PIN required for admin settings.</div>
        <button class="btn btn-primary" id="adminUnlock">🔓 Unlock admin</button></div></div>`;
      $('adminUnlock').onclick = async () => {
        const pin = await managerPin(); if (!pin) return;
        try { adminCat = (await API.call('adminCatalogue', { pin })).catalogue; renderAdmin(); } catch (e) { toast(e.message, true); }
      };
      return;
    }
    const custOpts = adminCat.customers.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    el.innerHTML = `
      ${!adminCat.customers.length ? `<div class="card"><div class="card-header">🚀 First-time setup</div><div class="card-body">
        <div class="banner warn">The Google Sheet has no customers or products yet. Load the starting catalogue (the 13 customers and all their products, copied from the old tool).</div>
        <button class="btn btn-primary" id="seedBtn">Load starting catalogue</button></div></div>` : ''}
      <div class="card"><div class="card-header">📦 Products <span class="muted" style="text-transform:none;letter-spacing:0;margin-left:auto">Changes apply to the staff tool and the customer portal on every device.</span></div><div class="card-body">
        <div class="admin-grid" style="margin-bottom:12px">
          <div><label class="lbl">Customer</label><select class="field" id="aCust" style="width:100%">${custOpts}</select></div>
          <div style="grid-column:span 2"><label class="lbl">Product</label><select class="field" id="aProd" style="width:100%"></select></div>
        </div>
        <div class="admin-grid">
          <div style="grid-column:span 2"><label class="lbl">Name</label><input class="field" id="aName" style="width:100%" maxlength="80"></div>
          <div><label class="lbl">Section</label><select class="field" id="aCat" style="width:100%">
            <option value="beef">Beef</option><option value="poultry">Poultry</option><option value="flavoured">Flavoured</option>
            <option value="chef-beef">Chef — Beef</option><option value="chef-chicken">Chef — Chicken</option><option value="chef-lamb">Chef — Lamb</option></select></div>
          <div><label class="lbl">Unit (beef)</label><select class="field" id="aUnit" style="width:100%"><option value="UNITS">UNITS</option><option value="KG">KG</option><option value="">—</option></select></div>
          <div><label class="lbl">Butcher multiplier (beef)</label><input class="field" id="aMult" type="number" step="0.5" min="0" style="width:100%"></div>
          <div><label class="lbl">PLU</label><input class="field" id="aPlu" style="width:100%"></div>
          <div><label class="lbl">Produced / packed as</label><input class="field" id="aProduceAs" placeholder="leave blank" style="width:100%"></div>
          <div><label class="lbl">Options</label>
            <label style="display:block;font-size:12px"><input type="checkbox" id="aFlav"> Flavoured (goes to chef)</label>
            <label style="display:block;font-size:12px"><input type="checkbox" id="aPortal"> Customer can order it on the portal</label>
            <label style="display:block;font-size:12px"><input type="checkbox" id="aActive"> Active</label></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-primary" id="aSave">💾 Save product</button>
          <button class="btn btn-ghost" id="aNew">➕ New product for this customer</button>
        </div>
        <div class="muted" style="font-size:11px;margin-top:8px">Untick “Active” to remove a product. Existing orders for it are kept and still print.</div>
      </div></div>
      <div class="card"><div class="card-header">🔑 PINs & links</div><div class="card-body">
        <div class="admin-grid">
          <div><label class="lbl">Change</label><select class="field" id="pWhich" style="width:100%"><option value="staff">Staff PIN</option><option value="manager">Manager PIN</option></select></div>
          <div><label class="lbl">New PIN (4–8 digits)</label><input class="field" id="pNew" type="password" inputmode="numeric" maxlength="8" style="width:100%"></div>
          <div><label class="lbl">Confirm</label><input class="field" id="pNew2" type="password" inputmode="numeric" maxlength="8" style="width:100%"></div>
          <div><button class="btn btn-primary" id="pSave">Save PIN</button></div>
        </div>
        <div class="admin-grid" style="margin-top:14px">
          <div><label class="lbl">Customer link</label><select class="field" id="tCust" style="width:100%">${custOpts}</select></div>
          <div><button class="btn btn-danger" id="tNew">Make new link (old one stops working)</button></div>
        </div>
      </div></div>
      <div class="card"><div class="card-header">🗄️ Data</div><div class="card-body" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="dExport">📤 Download full backup (JSON)</button>
        <span class="muted" style="font-size:12px;align-self:center">Everything is also in the Google Sheet (Orders, Submissions, Archive, Log tabs).</span>
      </div></div>
      <div class="card"><div class="card-header">ℹ️ About</div><div class="card-body muted" style="font-size:12px;line-height:1.7">
        ${esc(CFG.TOOL_NAME || '')} — build ${esc(CFG.BUILD || '')}<br>Connected to: <span class="mono">${esc(CFG.SCRIPT_URL || '')}</span><br>Signed in as: ${esc(S.role)}
      </div></div>`;

    if ($('seedBtn')) $('seedBtn').onclick = seedCatalogue;
    const fillProducts = () => {
      const c = adminCat.customers.find(x => x.id === $('aCust').value);
      $('aProd').innerHTML = c.products.map(p => `<option value="${esc(p.id)}">${esc(p.name)} [${esc(p.cat)}]${p.active ? '' : ' (INACTIVE)'}${p.staffOnly ? ' (staff only)' : ''}</option>`).join('');
      fillForm();
    };
    const fillForm = () => {
      const c = adminCat.customers.find(x => x.id === $('aCust').value);
      const p = c && c.products.find(x => x.id === $('aProd').value);
      $('aName').value = p ? p.name : ''; $('aCat').value = p ? p.cat : 'poultry'; $('aUnit').value = p ? (p.unit || '') : 'UNITS';
      $('aMult').value = p && p.mult !== undefined ? p.mult : ''; $('aPlu').value = p ? (p.plu || '') : ''; $('aProduceAs').value = p ? (p.produceAs || '') : '';
      $('aFlav').checked = !!(p && p.flavoured); $('aPortal').checked = p ? !p.staffOnly : true; $('aActive').checked = p ? p.active !== false : true;
      $('aSave').dataset.id = p ? p.id : '';
    };
    if (adminCat.customers.length) { $('aCust').onchange = fillProducts; $('aProd').onchange = fillForm; fillProducts(); }
    $('aNew').onclick = () => { $('aProd').value = ''; fillForm(); $('aSave').dataset.id = ''; $('aName').focus(); };
    $('aSave').onclick = saveProduct;
    $('pSave').onclick = changePin;
    $('tNew').onclick = newLink;
    $('dExport').onclick = exportAll;
  }

  async function seedCatalogue() {
    if (!window.SEED_CUSTOMERS) return toast('seed.js is missing', true);
    if (!confirm('Load the starting catalogue (13 customers) into the Google Sheet?')) return;
    const pin = await managerPin(); if (!pin) return;
    try {
      const r = await API.call('seedCatalogue', { pin, customers: window.SEED_CUSTOMERS }, { retries: 0, timeout: 60000 });
      toast('Loaded ' + r.customers + ' customers and ' + r.products + ' products');
      await reloadCatalogue();
      switchPanel('order');
    } catch (e) { toast(e.message, true); }
  }

  async function reloadCatalogue() {
    const pin = await managerPin();
    adminCat = (await API.call('adminCatalogue', { pin })).catalogue;
    S.catalogue = (await API.call('getCatalogue', { pin: S.pin })).catalogue;
    if (!S.cust && S.catalogue.customers.length) S.cust = S.catalogue.customers[0].id;
    renderAll(true);
  }

  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  async function saveProduct() {
    const custId = $('aCust').value;
    const name = $('aName').value.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!name) return toast('Enter a product name', true);
    const cat = $('aCat').value;
    let id = $('aSave').dataset.id;
    const cust = adminCat.customers.find(c => c.id === custId);
    if (!id) {
      id = slug(cat + '-' + name).slice(0, 70);
      let n = 2; const base = id; while (cust.products.some(p => p.id === id)) id = base + '-' + n++;
    }
    const multRaw = $('aMult').value.trim();
    const product = { id, cat, name, unit: $('aUnit').value, flavoured: $('aFlav').checked, staffOnly: !$('aPortal').checked, active: $('aActive').checked, plu: $('aPlu').value.trim(), produceAs: $('aProduceAs').value.trim().toUpperCase() };
    if (multRaw !== '') product.mult = Number(multRaw);
    const pin = await managerPin(); if (!pin) return;
    try { const r = await API.call('saveProduct', { pin, customer: custId, product }); toast(r.added ? 'Product added' : 'Product saved'); await reloadCatalogue(); $('aCust').value = custId; $('aCust').onchange(); $('aProd').value = id; $('aProd').onchange(); }
    catch (e) { toast(e.message, true); }
  }

  async function changePin() {
    const a = $('pNew').value.trim(), b = $('pNew2').value.trim();
    if (!/^\d{4,8}$/.test(a)) return toast('PIN must be 4–8 digits', true);
    if (a !== b) return toast('The two PINs do not match', true);
    const pin = await managerPin(); if (!pin) return;
    try {
      await API.call('changePin', { pin, which: $('pWhich').value, newPin: a });
      toast(($('pWhich').value === 'manager' ? 'Manager' : 'Staff') + ' PIN changed');
      if ($('pWhich').value === 'staff' && S.role === 'staff') { S.pin = a; if (lsGet(LS_PIN)) lsSet(LS_PIN, a); }
      if ($('pWhich').value === 'manager') { if (S.role === 'manager') { S.pin = a; if (lsGet(LS_PIN)) lsSet(LS_PIN, a); } S.managerPin = S.role === 'manager' ? '' : a; }
      $('pNew').value = $('pNew2').value = '';
    } catch (e) { toast(e.message, true); }
  }

  async function newLink() {
    const id = $('tCust').value, c = adminCat.customers.find(x => x.id === id);
    if (!confirm('Make a new link for ' + c.name + '? Their current link will stop working and you must send them the new one.')) return;
    const pin = await managerPin(); if (!pin) return;
    try { await API.call('newToken', { pin, customer: id }); toast('New link made — copy it from Customer Links'); await reloadCatalogue(); }
    catch (e) { toast(e.message, true); }
  }

  async function exportAll() {
    const pin = await managerPin(); if (!pin) return;
    try {
      const r = await API.call('exportAll', { pin }, { timeout: 60000 });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 1)], { type: 'application/json' }));
      a.download = 'mhmeats_new_backup_' + todayStr() + '.json';
      a.click();
      toast('Backup downloaded');
    } catch (e) { toast(e.message, true); }
  }

  // ── Boot ─────────────────────────────────────────────────────────
  window.App = { login: () => login(false), logout, shiftWeek, goToday, clearDay, print, copyAllLinks, refresh: () => refresh(false), _state: S };
  $('buildBadge').textContent = 'v' + (CFG.BUILD || '');
  $('todayBadge').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  if (!API.configured()) {
    $('configMsg').classList.remove('hidden');
    $('configMsg').textContent = 'Not connected yet: open config.js on GitHub and paste the Google Apps Script web app URL.';
    $('loginBtn').disabled = true;
  } else if (lsGet(LS_PIN)) { login(true); }
  else { $('pinInput').focus(); }
})();
