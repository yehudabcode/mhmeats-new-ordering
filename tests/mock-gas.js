// Minimal Google Apps Script + Sheets simulator, enough to run Code.gs unchanged.
// Usage: const gas = loadGas(path); gas.post({action:...}) ; or startServer(port)
const fs = require('fs'), vm = require('vm'), http = require('http'), crypto = require('crypto');

function colToNum(c) { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

function makeEnv() {
  const sheets = {};
  const props = {};
  const cache = {};
  function makeSheet(name) {
    const sh = { name, rows: [], textCols: new Set() };
    const cellSet = (r, c, v) => {
      while (sh.rows.length < r) sh.rows.push([]);
      const row = sh.rows[r - 1];
      while (row.length < c) row.push('');
      // Emulate Sheets auto-conversion outside plain-text columns
      if (!sh.textCols.has(c) && typeof v === 'string') {
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = new Date(v + 'T00:00:00');
        else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
        else if (v === 'TRUE' || v === 'FALSE') v = v === 'TRUE';
      }
      row[c - 1] = v === undefined || v === null ? '' : v;
    };
    const lastRow = () => { for (let i = sh.rows.length; i > 0; i--) if (sh.rows[i - 1].some(v => v !== '')) return i; return 0; };
    const lastCol = () => sh.rows.reduce((m, r) => { let k = r.length; while (k > 0 && r[k - 1] === '') k--; return Math.max(m, k); }, 0);
    function range(r, c, nr, nc) {
      return {
        setValues(vals) {
          if (vals.length !== nr || vals.some(v => v.length !== nc)) throw new Error(`Range size mismatch ${nr}x${nc} vs ${vals.length}x${vals[0] && vals[0].length}`);
          vals.forEach((row, i) => row.forEach((v, j) => cellSet(r + i, c + j, v)));
          return this;
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) { const row = sh.rows[r + i - 1] || []; const o = []; for (let j = 0; j < nc; j++) o.push(row[c + j - 1] === undefined ? '' : row[c + j - 1]); out.push(o); }
          return out;
        },
        clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (sh.rows[r + i - 1]) sh.rows[r + i - 1][c + j - 1] = ''; return this; },
        setNumberFormat(f) { if (f === '@') for (let j = c; j < c + nc; j++) sh.textCols.add(j); return this; },
      };
    }
    sh.api = {
      getName: () => name,
      getLastRow: lastRow,
      getLastColumn: lastCol,
      setFrozenRows() {},
      appendRow(vals) { const r = lastRow() + 1; vals.forEach((v, j) => cellSet(r, j + 1, v)); },
      getRange(a, b, c, d) {
        if (typeof a === 'string') { const m = a.match(/^([A-Z]+):([A-Z]+)$/); const c1 = colToNum(m[1]), c2 = colToNum(m[2]); return range(1, c1, 100000, c2 - c1 + 1); }
        if (c === undefined) c = 1; if (d === undefined) d = 1;
        if (c < 1 || d < 1) throw new Error('The number of rows in the range must be at least 1.');
        return range(a, b, c, d);
      },
    };
    return sh;
  }
  const ss = {
    setSpreadsheetTimeZone() {},
    getSheetByName: n => (sheets[n] ? sheets[n].api : null),
    insertSheet: n => { sheets[n] = makeSheet(n); return sheets[n].api; },
  };
  let locked = false;
  const pad = n => String(n).padStart(2, '0');
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (locked) return false; locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        const s = d.toLocaleString('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); // dd/mm/yyyy
        const [dd, mm, yyyy] = s.split('/');
        if (fmt !== 'yyyy-MM-dd') throw new Error('mock formatDate only supports yyyy-MM-dd');
        return `${yyyy}-${mm}-${dd}`;
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => { const ch = { timeBased: () => ch, everyDays: () => ch, atHour: () => ch, create: () => ch }; return ch; } },
    console, Date, JSON, Math, Number, String, Object, Array, isNaN, isFinite, parseInt, Error,
  };
  vm.createContext(ctx);
  return { ctx, sheets, props, cache };
}

function loadGas(codePath) {
  const env = makeEnv();
  vm.runInContext(fs.readFileSync(codePath, 'utf8') + '\n;this.__A={setup,doGet,doPost,nightly,ACTIONS};', env.ctx);
  const A = env.ctx.__A;
  return {
    env, A,
    post: body => JSON.parse(A.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text),
    get: () => JSON.parse(A.doGet({ parameter: {} }).text),
  };
}

function startServer(codePath, port) {
  const gas = loadGas(codePath);
  gas.A.setup();
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (req.url.startsWith('/__fail')) { gas.failNext = Number(req.url.split('=')[1] || 1); res.writeHead(200, cors); return res.end('{}'); }
    if (req.method === 'OPTIONS') { res.writeHead(405); return res.end(); } // Apps Script never answers preflight
    if (req.method === 'GET') { res.writeHead(200, cors); return res.end(JSON.stringify(gas.get())); }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if ((req.headers['content-type'] || '').indexOf('text/plain') !== 0) { res.writeHead(415); return res.end('must be simple request'); }
      if (gas.failNext > 0) { gas.failNext--; res.writeHead(500, cors); return res.end('<html>Google error</html>'); }
      setTimeout(() => { res.writeHead(200, cors); res.end(JSON.stringify(JSON.parse(gas.A.doPost({ postData: { contents: body } }).text))); }, 30);
    });
  });
  server.listen(port);
  return { server, gas };
}

module.exports = { loadGas, startServer };
if (require.main === module) { startServer(process.argv[2], Number(process.argv[3] || 8787)); console.log('mock GAS on', process.argv[3] || 8787); }
