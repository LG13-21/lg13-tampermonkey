// ==UserScript==
// @name         LG13 Claude Usage Monitor
// @namespace    lg13.local
// @version      1.0
// @description  Auto-parse Claude usage progress bars + POST to localhost:8790/pl/usage/ingest (#2687)
// @match        https://claude.ai/settings/usage*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.__LG13_USAGE__) return;
  window.__LG13_USAGE__ = true;

  const INGEST = 'http://127.0.0.1:8790/pl/usage/ingest';
  const POLL_MS = 5 * 60 * 1000; // 5 min
  const log = (...a) => console.log('[LG13-USAGE]', ...a);

  let lastPayloadHash = null;

  // ---- helpers ---------------------------------------------------------------

  function parsePct(el) {
    if (!el) return null;
    const style = el.style.width || el.getAttribute('aria-valuenow') || '';
    const m = style.match(/([\d.]+)/);
    if (m) return parseFloat(m[1]);
    const txt = el.textContent || '';
    const m2 = txt.match(/([\d.]+)%/);
    if (m2) return parseFloat(m2[1]);
    return null;
  }

  function parseTimeStr(txt) {
    if (!txt) return null;
    return txt.trim().replace(/\s+/g, ' ');
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
    return h.toString(16);
  }

  // ---- parser ----------------------------------------------------------------

  function parseUsagePage() {
    const result = {
      session_pct: null,
      weekly_all: null,
      weekly_sonnet: null,
      weekly_design: null,
      session_resets_in: null,
      weekly_resets_at: null,
      ts: new Date().toISOString(),
    };

    // Find all progress bars - aria role progressbar or div with width% style
    const bars = Array.from(document.querySelectorAll('[role="progressbar"], .progress, [class*="progress"]'));
    bars.forEach(bar => {
      const pct = parsePct(bar.querySelector('[style*="width"]') || bar);
      const label = (bar.closest('[class*="row"], section, .usage-item, li') || bar)
        .textContent.toLowerCase();
      if (label.includes('session') && result.session_pct === null) result.session_pct = pct;
      else if (label.includes('sonnet') && result.weekly_sonnet === null) result.weekly_sonnet = pct;
      else if (label.includes('design') && result.weekly_design === null) result.weekly_design = pct;
      else if (label.includes('week') && result.weekly_all === null) result.weekly_all = pct;
    });

    // Fallback: try percentage text nodes
    if (result.session_pct === null && result.weekly_all === null) {
      const sections = document.querySelectorAll('section, [class*="usage"], [class*="quota"]');
      sections.forEach(sec => {
        const txt = sec.textContent;
        const m = txt.match(/([\d.]+)%/g);
        if (m && m.length) {
          const label = txt.toLowerCase();
          const v = parseFloat(m[0]);
          if (label.includes('session') && result.session_pct === null) result.session_pct = v;
          else if (label.includes('week') && result.weekly_all === null) result.weekly_all = v;
        }
      });
    }

    // Reset timers: look for text like "resets in Xh Ym" or "resets at HH:MM"
    const fullText = document.body.innerText || '';
    const resetIn = fullText.match(/resets?\s+in\s+([\d\w\s]+?)(?:\n|,|\.)/i);
    if (resetIn) result.session_resets_in = parseTimeStr(resetIn[1]);
    const resetAt = fullText.match(/resets?\s+(?:at\s+)?([\d]{1,2}:[\d]{2}[^\n,]{0,20})/i);
    if (resetAt) result.weekly_resets_at = parseTimeStr(resetAt[1]);

    return result;
  }

  // ---- POST to pl_server -----------------------------------------------------

  function postUsage(payload) {
    const body = JSON.stringify(payload);
    const hash = hashStr(body);
    if (hash === lastPayloadHash) {
      log('Skipping duplicate POST');
      return;
    }
    lastPayloadHash = hash;
    GM_xmlhttpRequest({
      method: 'POST',
      url: INGEST,
      headers: { 'Content-Type': 'application/json' },
      data: body,
      onload: (r) => {
        try {
          const d = JSON.parse(r.responseText);
          log('Ingested:', d);
        } catch (e) {
          log('Ingest response parse error:', r.responseText);
        }
      },
      onerror: (e) => log('Ingest error:', e),
    });
  }

  // ---- main loop -------------------------------------------------------------

  function run() {
    const payload = parseUsagePage();
    log('Parsed usage:', payload);
    postUsage(payload);
  }

  // Inject refresh button
  function injectButton() {
    if (document.getElementById('lg13-usage-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'lg13-usage-btn';
    btn.textContent = '↺ LG13 Sync Usage';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;padding:8px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    btn.onclick = () => { run(); btn.textContent = '✓ Synced'; setTimeout(() => { btn.textContent = '↺ LG13 Sync Usage'; }, 2000); };
    document.body.appendChild(btn);
  }

  // Wait for page to load then run
  const observer = new MutationObserver(() => {
    if (document.querySelector('[role="progressbar"], [class*="progress"]')) {
      observer.disconnect();
      setTimeout(() => { run(); injectButton(); }, 1000);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Poll every 5 minutes
  setInterval(run, POLL_MS);

  // Initial run after 2s
  setTimeout(() => { run(); injectButton(); }, 2000);

})();
