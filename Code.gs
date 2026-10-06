// ══════════════════════════════════════════════════════════════════
// MH MEATS NEW ORDERING TOOL — Google Apps Script backend
// Paste this whole file into Extensions → Apps Script of the NEW sheet.
// Run setup() once, then Deploy → New deployment → Web app
//   (Execute as: Me, Who has access: Anyone).
//
// The Google Sheet is the ONE shared order book. Nothing is "used up":
// every PC reads the same orders, and reading never changes anything.
// ══════════════════════════════════════════════════════════════════

const BACKEND_VERSION = '1.0.0';
const TZ = 'Europe/London';
const ARCHIVE_AFTER_DAYS = 45;   // orders older than this move to the Archive tab nightly

const TABS = {
  customers:   ['Id', 'Name', 'Short', 'Color', 'Bulk', 'Token', 'Active', 'Sort'],
  catalogue:   ['CustomerId', 'ProductId', 'Cat', 'Name', 'Unit', 'Mult', 'Flavoured', 'PLU', 'StaffOnly', 'ProduceAs', 'Active', 'Sort'],
  orders:      ['Date', 'CustomerId', 'ProductId', 'Qty', 'Note', 'Source', 'UpdatedAt', 'UpdatedBy'],
  submissions: ['Timestamp', 'SubmissionId', 'CustomerId', 'Date', 'Lines', 'Note', 'LineCount'],
  archive:     ['Date', 'CustomerId', 'ProductId', 'Qty', 'Note', 'Source', 'UpdatedAt', 'UpdatedBy'],
  log:         ['Timestamp', 'Who', 'Action', 'Detail'],
};
const TEXT_COLS = { customers: 'A:F', catalogue: 'A:E', orders: 'A:C', submissions: 'A:D', archive: 'A:C', log: 'A:A' };
const TAB_NAMES = { customers: 'Customers', catalogue: 'Catalogue', orders: 'Orders', submissions: 'Submissions', archive: 'Archive', log: 'Log' };
const CATS = ['beef', 'poultry', 'flavoured', 'chef-beef', 'chef-chicken', 'chef-lamb'];

// ══════════════════════════════════════════════════════════════════
// ONE-TIME SETUP — select "setup" in the toolbar and press ▶ Run
// ══════════════════════════════════════════════════════════════════
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(TABS).forEach(k => sheet_(k));
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('STAFF_PIN')) props.setProperty('STAFF_PIN', '1234');
  if (!props.getProperty('MANAGER_PIN')) props.setProperty('MANAGER_PIN', '9999');
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'nightly') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('nightly').timeBased().everyDays(1).atHour(2).create();
  log_('setup', 'setup', 'Tabs checked, nightly archive scheduled');
  return 'Setup complete. Staff PIN is 1234 and Manager PIN is 9999 — change both in the tool: Admin → PINs.';
}

// ══════════════════════════════════════════════════════════════════
// HTTP entry points
// ══════════════════════════════════════════════════════════════════
function doGet(e) {
  // Browser check: open the web app URL — you should see {"ok":true,...}
  return json_({ ok: true, service: 'MH Meats New Ordering Tool', version: BACKEND_VERSION, time: nowIso_() });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad request (not JSON)' });
  }
  try {
    const fn = ACTIONS[req.action];
    if (!fn) return json_({ ok: false, error: 'Unknown action: ' + req.action });
    return json_(fn(req));
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (msg.indexOf('AUTH:') === 0) return json_({ ok: false, auth: true, error: msg.slice(5) });
    try { log_('error', req.action || '?', msg); } catch (e2) {}
    return json_({ ok: false, error: msg });
  }
}

const ACTIONS = {
  ping: () => ({ ok: true, version: BACKEND_VERSION, time: nowIso_() }),

  // ── Staff ──────────────────────────────────────────────────────
  login: req => { const role = auth_(req, 'staff'); return { ok: true, role: role }; },

  getCatalogue: req => { auth_(req, 'staff'); return { ok: true, catalogue: readCatalogue_(false) }; },

  getOrders: req => {
    auth_(req, 'staff');
    const from = checkDate_(req.from), to = checkDate_(req.to);
    return {
      ok: true,
      serverTime: nowIso_(),
      orders: readOrders_(from, to),
      custNotes: readCustNotes_(from, to),
      submissions: readSubmissions_({ sinceIso: req.since || '', limit: req.since ? 200 : 40 }),
    };
  },

  setLines: req => {
    auth_(req, 'staff');
    const date = checkDate_(req.date);
    const cat = readCatalogue_(false);
    const cust = cat.customers.filter(c => c.id === req.customer)[0];
    if (!cust) throw new Error('Unknown customer: ' + req.customer);
    const valid = {};
    cust.products.forEach(p => { valid[p.id] = true; });
    const changes = (req.changes || []).map(ch => {
      if (!valid[ch.productId]) throw new Error('Unknown product for ' + cust.name + ': ' + ch.productId);
      return { productId: ch.productId, qty: cleanQty_(ch.qty), note: cleanNote_(ch.note) };
    });
    withLock_(() => upsertLines_(date, cust.id, changes, 'staff', cleanWho_(req.by)));
    const day = readOrders_(date, date)[date] || {};
    return { ok: true, saved: changes.length, lines: day[cust.id] || {} };
  },

  clearDay: req => {
    auth_(req, 'manager');
    const date = checkDate_(req.date);
    let n = 0;
    withLock_(() => {
      const sh = sheet_('orders');
      const data = values_(sh);
      for (let i = 0; i < data.length; i++) {
        if (dateStr_(data[i][0]) === date && Number(data[i][3]) > 0) {
          sh.getRange(i + 2, 4, 1, 1).setValues([[0]]);
          sh.getRange(i + 2, 7, 1, 2).setValues([[nowIso_(), 'manager: clear day']]);
          n++;
        }
      }
    });
    log_('manager', 'clearDay', date + ' (' + n + ' lines)');
    return { ok: true, cleared: n };
  },

  // ── Admin (manager PIN) ────────────────────────────────────────
  adminCatalogue: req => { auth_(req, 'manager'); return { ok: true, catalogue: readCatalogue_(true) }; },

  seedCatalogue: req => {
    auth_(req, 'manager');
    const custs = req.customers || [];
    if (!custs.length) throw new Error('No customers supplied');
    return withLock_(() => {
      const cs = sheet_('customers'), ps = sheet_('catalogue');
      if (cs.getLastRow() > 1 && !req.force) throw new Error('Catalogue already loaded. Nothing changed.');
      if (cs.getLastRow() > 1) cs.getRange(2, 1, cs.getLastRow() - 1, TABS.customers.length).clearContent();
      if (ps.getLastRow() > 1) ps.getRange(2, 1, ps.getLastRow() - 1, TABS.catalogue.length).clearContent();
      const cRows = [], pRows = [];
      custs.forEach((c, ci) => {
        if (!c.id || !c.name) throw new Error('Customer missing id/name');
        cRows.push([c.id, c.name, c.short || c.id.slice(0, 3).toUpperCase(), c.color || '#888888', !!c.bulk, newToken_(), true, ci + 1]);
        const seen = {};
        (c.products || []).forEach((p, pi) => {
          validateProduct_(p);
          if (seen[p.id]) throw new Error('Duplicate product id ' + p.id + ' for ' + c.id);
          seen[p.id] = true;
          pRows.push([c.id, p.id, p.cat, p.name, p.unit || '', p.mult === undefined ? '' : p.mult, !!p.flavoured, p.plu || '', !!p.staffOnly, p.produceAs || '', true, pi + 1]);
        });
      });
      cs.getRange(2, 1, cRows.length, cRows[0].length).setValues(cRows);
      if (pRows.length) ps.getRange(2, 1, pRows.length, pRows[0].length).setValues(pRows);
      log_('manager', 'seedCatalogue', cRows.length + ' customers, ' + pRows.length + ' products');
      return { ok: true, customers: cRows.length, products: pRows.length };
    });
  },

  saveProduct: req => {
    auth_(req, 'manager');
    const p = req.product || {};
    validateProduct_(p);
    return withLock_(() => {
      const cat = readCatalogue_(true);
      const cust = cat.customers.filter(c => c.id === req.customer)[0];
      if (!cust) throw new Error('Unknown customer');
      const sh = sheet_('catalogue');
      const data = values_(sh);
      for (let i = 0; i < data.length; i++) {
        if (data[i][0] === cust.id && data[i][1] === p.id) {
          sh.getRange(i + 2, 3, 1, 8).setValues([[p.cat, p.name, p.unit || '', p.mult === undefined || p.mult === null ? '' : p.mult, !!p.flavoured, p.plu || '', !!p.staffOnly, p.produceAs || '']]);
          sh.getRange(i + 2, 11, 1, 1).setValues([[p.active !== false]]);
          log_('manager', 'editProduct', cust.id + ' ' + p.id + ' → ' + p.name);
          return { ok: true, updated: true };
        }
      }
      if (cust.products.some(x => x.name === p.name && x.cat === p.cat)) throw new Error(p.name + ' already exists for ' + cust.name);
      const sort = cust.products.reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1;
      sh.getRange(sh.getLastRow() + 1, 1, 1, TABS.catalogue.length).setValues([[cust.id, p.id, p.cat, p.name, p.unit || '', p.mult === undefined || p.mult === null ? '' : p.mult, !!p.flavoured, p.plu || '', !!p.staffOnly, p.produceAs || '', true, sort]]);
      log_('manager', 'addProduct', cust.id + ' ' + p.id + ' ' + p.name);
      return { ok: true, added: true };
    });
  },

  changePin: req => {
    auth_(req, 'manager');
    const which = req.which === 'manager' ? 'MANAGER_PIN' : 'STAFF_PIN';
    const pin = String(req.newPin || '');
    if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4–8 digits');
    PropertiesService.getScriptProperties().setProperty(which, pin);
    log_('manager', 'changePin', which);
    return { ok: true };
  },

  newToken: req => {
    auth_(req, 'manager');
    return withLock_(() => {
      const sh = sheet_('customers');
      const data = values_(sh);
      for (let i = 0; i < data.length; i++) {
        if (data[i][0] === req.customer) {
          const t = newToken_();
          sh.getRange(i + 2, 6, 1, 1).setValues([[t]]);
          log_('manager', 'newToken', req.customer);
          return { ok: true, token: t };
        }
      }
      throw new Error('Unknown customer');
    });
  },

  exportAll: req => {
    auth_(req, 'manager');
    return { ok: true, exportedAt: nowIso_(), catalogue: readCatalogue_(true), orders: values_(sheet_('orders')), submissions: values_(sheet_('submissions')) };
  },

  // ── Customer portal (customer id + secret token from their link) ──
  portalInit: req => {
    const cust = portalAuth_(req);
    return {
      ok: true,
      customer: { id: cust.id, name: cust.name, short: cust.short, color: cust.color },
      products: cust.products.filter(p => p.active && !p.staffOnly)
        .map(p => ({ id: p.id, cat: p.cat, name: p.name, unit: p.unit, plu: p.plu, flavoured: p.flavoured })),
      today: todayStr_(),
    };
  },

  portalGetOrder: req => {
    const cust = portalAuth_(req);
    const date = checkDate_(req.date);
    const visible = {};
    cust.products.forEach(p => { if (!p.staffOnly) visible[p.id] = true; });
    const day = (readOrders_(date, date)[date] || {})[cust.id] || {};
    const lines = {};
    Object.keys(day).forEach(pid => { if (visible[pid]) lines[pid] = day[pid].qty; });
    const subs = readSubmissions_({ customer: cust.id, date: date, limit: 1 });
    return { ok: true, date: date, lines: lines, lastSubmitted: subs.length ? subs[0].timestamp : '' };
  },

  portalSubmit: req => {
    const cust = portalAuth_(req);
    const date = checkDate_(req.date);
    const today = todayStr_();
    if (date < today) throw new Error('That delivery date has passed. Please pick today or a later date.');
    if (daysBetween_(today, date) > 21) throw new Error('Orders can only be placed up to 3 weeks ahead.');
    const submissionId = String(req.submissionId || '').slice(0, 64);
    if (!submissionId) throw new Error('Missing submission id');

    const visible = {};
    cust.products.forEach(p => { if (p.active && !p.staffOnly) visible[p.id] = p; });
    const lines = req.lines || {};
    const bad = Object.keys(lines).filter(pid => !visible[pid]);
    if (bad.length) throw new Error('Your product list has changed. Please reload the page and try again. (' + bad.join(', ') + ')');

    return withLock_(() => {
      // Same submission sent twice (e.g. double tap, retry after bad signal) → do nothing the second time
      const dup = readSubmissions_({ submissionId: submissionId, limit: 1 });
      if (dup.length) return { ok: true, duplicate: true, submissionId: submissionId, count: dup[0].lineCount };

      // The customer's submission REPLACES their previous order for that date
      // (only for products they can see — staff-only lines are left alone).
      const changes = Object.keys(visible).map(pid => ({ productId: pid, qty: cleanQty_(lines[pid]), note: null }));
      upsertLines_(date, cust.id, changes, 'portal', 'customer');
      const clean = {};
      Object.keys(lines).forEach(pid => { const q = cleanQty_(lines[pid]); if (q > 0) clean[pid] = q; });
      const count = Object.keys(clean).length;
      sheet_('submissions').appendRow([nowIso_(), submissionId, cust.id, date, JSON.stringify(clean), cleanNote_(req.note) || '', count]);
      return { ok: true, submissionId: submissionId, count: count, date: date };
    });
  },

  portalHistory: req => {
    const cust = portalAuth_(req);
    const days = Math.min(Math.max(parseInt(req.days, 10) || 14, 1), 60);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return { ok: true, submissions: readSubmissions_({ customer: cust.id, sinceIso: cutoff, limit: 30 }) };
  },
};

// ══════════════════════════════════════════════════════════════════
// Nightly housekeeping (installed by setup)
// ══════════════════════════════════════════════════════════════════
function nightly() {
  withLock_(() => {
    const cutoff = addDays_(todayStr_(), -ARCHIVE_AFTER_DAYS);
    const sh = sheet_('orders');
    const data = values_(sh);
    if (!data.length) return;
    const keep = [], move = [];
    data.forEach(r => {
      if (dateStr_(r[0]) < cutoff) { if (Number(r[3]) > 0) move.push(r); }
      else if (Number(r[3]) > 0 || String(r[4] || '') !== '' || dateStr_(r[0]) >= addDays_(todayStr_(), -7)) keep.push(r);
    });
    if (move.length) {
      const ar = sheet_('archive');
      ar.getRange(ar.getLastRow() + 1, 1, move.length, move[0].length).setValues(move.map(r => [dateStr_(r[0])].concat(r.slice(1))));
    }
    sh.getRange(2, 1, data.length, TABS.orders.length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, keep[0].length).setValues(keep.map(r => [dateStr_(r[0])].concat(r.slice(1))));
    log_('system', 'nightly', 'archived ' + move.length + ', kept ' + keep.length);
  });
}

// ══════════════════════════════════════════════════════════════════
// Data access
// ══════════════════════════════════════════════════════════════════
function sheet_(key) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = TAB_NAMES[key];
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABS[key].length).setValues([TABS[key]]);
    sh.setFrozenRows(1);
    // Date / id columns stored as plain text so Sheets never reformats them
    sh.getRange(TEXT_COLS[key]).setNumberFormat('@');
  }
  return sh;
}

function values_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
}

function readCatalogue_(includeInactive) {
  const custs = values_(sheet_('customers')).filter(r => r[0] !== '');
  const prods = values_(sheet_('catalogue')).filter(r => r[0] !== '');
  const byCust = {};
  prods.forEach(r => {
    const p = { id: String(r[1]), cat: String(r[2]), name: String(r[3]), unit: String(r[4] || ''), flavoured: bool_(r[6]), plu: r[7] === '' ? '' : String(r[7]), staffOnly: bool_(r[8]), produceAs: String(r[9] || ''), active: r[10] === '' ? true : bool_(r[10]), sort: Number(r[11]) || 0 };
    if (r[5] !== '' && r[5] !== null) p.mult = Number(r[5]);
    if (!includeInactive && !p.active) return;
    (byCust[r[0]] = byCust[r[0]] || []).push(p);
  });
  const customers = custs
    .map(r => ({ id: String(r[0]), name: String(r[1]), short: String(r[2]), color: String(r[3]), bulk: bool_(r[4]), token: String(r[5]), active: r[6] === '' ? true : bool_(r[6]), sort: Number(r[7]) || 0 }))
    .filter(c => includeInactive || c.active)
    .sort((a, b) => a.sort - b.sort);
  customers.forEach(c => { c.products = (byCust[c.id] || []).sort((a, b) => a.sort - b.sort); });
  return { customers: customers };
}

function readOrders_(from, to) {
  const out = {};
  values_(sheet_('orders')).forEach(r => {
    const d = dateStr_(r[0]);
    if (d < from || d > to) return;
    const q = Number(r[3]) || 0;
    const note = String(r[4] || '');
    if (q <= 0) return;
    const day = out[d] = out[d] || {};
    const c = day[r[1]] = day[r[1]] || {};
    c[r[2]] = { qty: q, note: note };
  });
  return out;
}

function readCustNotes_(from, to) {
  // Latest non-empty order note per customer per date, from portal submissions
  const out = {};
  values_(sheet_('submissions')).forEach(r => {
    const d = dateStr_(r[3]);
    if (d < from || d > to || !r[5]) return;
    (out[d] = out[d] || {})[r[2]] = String(r[5]);
  });
  return out;
}

function readSubmissions_(opt) {
  const rows = values_(sheet_('submissions'));
  const out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < (opt.limit || 50); i--) {
    const r = rows[i];
    const ts = tsStr_(r[0]);
    if (opt.sinceIso && ts <= opt.sinceIso) break;          // rows are appended in time order
    if (opt.customer && r[2] !== opt.customer) continue;
    if (opt.date && dateStr_(r[3]) !== opt.date) continue;
    if (opt.submissionId && String(r[1]) !== opt.submissionId) continue;
    let lines = {};
    try { lines = JSON.parse(r[4] || '{}'); } catch (e) {}
    out.push({ timestamp: ts, submissionId: String(r[1]), customer: String(r[2]), date: dateStr_(r[3]), lines: lines, note: String(r[5] || ''), lineCount: Number(r[6]) || 0 });
  }
  return out;
}

// changes: [{productId, qty, note}] — note null means "leave note as it is"
function upsertLines_(date, custId, changes, source, who) {
  if (!changes.length) return;
  const sh = sheet_('orders');
  const data = values_(sh);
  const index = {};
  data.forEach((r, i) => { if (dateStr_(r[0]) === date && r[1] === custId) index[r[2]] = i; });
  const now = nowIso_();
  const appends = [];
  changes.forEach(ch => {
    const i = index[ch.productId];
    if (i !== undefined) {
      const r = data[i];
      const note = ch.note === null ? String(r[4] || '') : ch.note;
      if (Number(r[3]) === ch.qty && String(r[4] || '') === note) return;   // nothing changed
      sh.getRange(i + 2, 4, 1, 5).setValues([[ch.qty, note, source, now, who]]);
    } else {
      const note = ch.note === null ? '' : ch.note;
      if (ch.qty <= 0 && !note) return;
      appends.push([date, custId, ch.productId, ch.qty, note, source, now, who]);
    }
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, appends[0].length).setValues(appends);
}

// ══════════════════════════════════════════════════════════════════
// Security
// ══════════════════════════════════════════════════════════════════
function auth_(req, need) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pinFails') || 0);
  if (fails >= 15) throw new Error('AUTH:Too many wrong PINs. Wait 10 minutes and try again.');
  const props = PropertiesService.getScriptProperties();
  const pin = String(req.pin || '');
  const manager = pin !== '' && pin === props.getProperty('MANAGER_PIN');
  const staff = manager || (pin !== '' && pin === props.getProperty('STAFF_PIN'));
  if ((need === 'manager' && !manager) || (need === 'staff' && !staff)) {
    cache.put('pinFails', String(fails + 1), 600);
    throw new Error(need === 'manager' ? 'AUTH:Manager PIN required' : 'AUTH:Wrong PIN');
  }
  return manager ? 'manager' : 'staff';
}

function portalAuth_(req) {
  const cat = readCatalogue_(true);
  const cust = cat.customers.filter(c => c.id === req.customer && c.active)[0];
  if (!cust || !req.token || String(req.token) !== cust.token) throw new Error('AUTH:This order link is not valid. Please ask MH Meats for a new link.');
  return cust;
}

function validateProduct_(p) {
  if (!p || !p.id || !/^[a-z0-9-]{2,80}$/.test(p.id)) throw new Error('Bad product id');
  if (CATS.indexOf(p.cat) < 0) throw new Error('Bad category: ' + p.cat);
  if (!p.name || String(p.name).length > 80) throw new Error('Product name missing or too long');
  if (p.mult !== undefined && p.mult !== null && p.mult !== '' && !(Number(p.mult) >= 0)) throw new Error('Bad multiplier');
}

// ══════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Server busy — please try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function nowIso_() { return new Date().toISOString(); }
function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}
function tsStr_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }
function checkDate_(s) {
  s = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T12:00:00Z'))) throw new Error('Bad date: ' + s);
  return s;
}
function addDays_(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween_(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000); }
function cleanQty_(q) {
  const n = Number(q);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n * 100) / 100, 100000);
}
function cleanNote_(s) { return s === null || s === undefined ? '' : String(s).replace(/[\r\n]+/g, ' ').slice(0, 300); }
function cleanWho_(s) { return String(s || 'staff').slice(0, 40); }
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function newToken_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function log_(who, action, detail) {
  try { sheet_('log').appendRow([nowIso_(), who, action, String(detail).slice(0, 500)]); } catch (e) {}
}
