// ══════════════════════════════════════════════════════════════════
// MH MEATS NEW ORDERING TOOL — connection to the Google Sheet
// Every call is a plain POST with no Google cookies, so it works no matter
// which Google accounts are signed in on the PC.
// ══════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const cfg = window.MH_CONFIG || {};

  function configured() {
    return /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(cfg.SCRIPT_URL || '') || /^http:\/\/(localhost|127\.0\.0\.1)/.test(cfg.SCRIPT_URL || '');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function once(payload, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      // String body → Content-Type text/plain → no pre-flight request, which Apps Script cannot answer.
      res = await fetch(cfg.SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow', credentials: 'omit', signal: ctrl.signal });
    } catch (e) {
      const err = new Error(e.name === 'AbortError' ? 'The server took too long to answer.' : 'No connection to the server.');
      err.retry = true; throw err;
    } finally { clearTimeout(timer); }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      const err = new Error(res.ok ? 'The server sent an unexpected page (is the web app deployed for "Anyone"?)' : 'Server error ' + res.status);
      err.retry = true; throw err;
    }
    if (!data.ok) {
      const err = new Error(data.error || 'Unknown server error');
      err.auth = !!data.auth; err.retry = false; err.server = true; throw err;
    }
    return data;
  }

  // All actions are safe to repeat (quantities are absolute, submissions carry an id),
  // so network failures are retried automatically.
  async function call(action, payload, opts) {
    opts = opts || {};
    if (!configured()) throw Object.assign(new Error('The tool is not connected yet: paste the web app URL into config.js.'), { config: true });
    const tries = opts.retries === undefined ? 3 : opts.retries;
    let lastErr;
    for (let i = 0; i <= tries; i++) {
      try { return await once(Object.assign({ action: action }, payload || {}), opts.timeout || 25000); }
      catch (e) { lastErr = e; if (!e.retry || i === tries) break; await sleep(800 * Math.pow(2, i)); }
    }
    throw lastErr;
  }

  window.MHApi = { call: call, configured: configured };
})();
