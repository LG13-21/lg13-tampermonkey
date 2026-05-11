// ==UserScript==
// @name         LG13 Claude Usage Monitor
// @namespace    lg13.local
// @version      2.7
// @description  Parse Claude usage page (session/weekly %, resets, plan) → POST localhost:8790/pl/usage/ingest. Shows last-sync overlay. (#2687) [v2.7: aria-valuenow primary + forward-sibling-walk from h3 label (fixes querySelector-returns-first-bar bug); handles label-with-subtitle pattern]
// @match        https://claude.ai/settings/usage*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_claude_usage.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_claude_usage.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__LG13_USAGE__) return;
  window.__LG13_USAGE__ = true;

  const INGEST = 'http://127.0.0.1:8790/pl/usage/ingest';
  const POLL_MS = 5 * 60 * 1000;
  const LS_LAST = 'lg13_usage_last';
  const log = (...a) => console.log('[LG13-USAGE]', ...a);

  let lastPayloadHash = null;

  // ---- helpers ---------------------------------------------------------------

  function parsePctFromAny(node) {
    if (!node) return null;
    if (node.getAttribute) {
      const aria = node.getAttribute('aria-valuenow');
      if (aria != null && aria !== '') {
        const v = parseFloat(aria);
        if (!Number.isNaN(v)) return v;
      }
    }
    const inner = node.querySelector && node.querySelector('[style*="width"]');
    const styleStr = (inner && inner.style && inner.style.width) || (node.style && node.style.width) || '';
    let m = styleStr.match(/([\d.]+)\s*%/);
    if (m) return parseFloat(m[1]);
    const txt = (node.textContent || '').trim();
    m = txt.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (m) return parseFloat(m[1]);
    return null;
  }

  function nearestLabelText(el) {
    const ctx = el.closest('section, li, [class*="row"], [class*="usage"], [class*="quota"], [class*="card"], div');
    return ((ctx && ctx.textContent) || el.textContent || '').toLowerCase();
  }

  function classify(label) {
    if (!label) return null;
    if (/\bsession\b|\b5[\s-]?h\b|five[\s-]?hour/.test(label)) return 'session';
    if (/\bsonnet\b/.test(label)) return 'weekly_sonnet';
    if (/\bopus\b/.test(label)) return 'weekly_opus';
    if (/\bdesign|artifacts?\b/.test(label)) return 'weekly_design';
    if (/\bweek|7[\s-]?day\b/.test(label)) return 'weekly_all';
    return null;
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
    return h.toString(16);
  }

  // ---- parser ----------------------------------------------------------------

  // Map of exact label text (as it appears on page) → result key
  const LABEL_MAP = {
    'current session': 'session_pct',
    'all models':      'weekly_all',
    'sonnet only':     'weekly_sonnet',
    'opus only':       'weekly_opus',
    'claude design':   'weekly_design',
    'design':          'weekly_design',
  };

  // Given a label span, find the associated progressbar value.
  // KEY INSIGHT (v2.7): label and bar live in adjacent column containers.
  // Walking ancestors with querySelector returns the FIRST progressbar in subtree
  // — wrong for non-first sections (Sonnet/Opus/Design under Weekly limits row).
  // Fix: forward-sibling walk from label, prefer aria-valuenow attribute.
  function pctFromLabelSpan(span) {
    // Strategy A: forward siblings of the label span itself
    let sib = span.nextElementSibling;
    while (sib) {
      const bar = sib.matches && sib.matches('[role="progressbar"]') ? sib : (sib.querySelector && sib.querySelector('[role="progressbar"]'));
      if (bar) return parsePctFromAny(bar);
      sib = sib.nextElementSibling;
    }
    // Strategy B: walk up; at each level inspect following siblings of current node
    let node = span.parentElement;
    for (let i = 0; i < 6 && node && node.tagName !== 'SECTION' && node.tagName !== 'MAIN' && node !== document.body; i++) {
      let s = node.nextElementSibling;
      while (s) {
        const bar = s.matches && s.matches('[role="progressbar"]') ? s : (s.querySelector && s.querySelector('[role="progressbar"]'));
        if (bar) return parsePctFromAny(bar);
        s = s.nextElementSibling;
      }
      node = node.parentElement;
    }
    // Strategy C (last resort): closest container that has EXACTLY one progressbar (scoped)
    node = span.parentElement;
    for (let i = 0; i < 8 && node && node.tagName !== 'SECTION' && node.tagName !== 'MAIN' && node !== document.body; i++) {
      const bars = node.querySelectorAll('[role="progressbar"]');
      if (bars.length === 1) return parsePctFromAny(bars[0]);
      node = node.parentElement;
    }
    return null;
  }

  function parseUsagePage() {
    const result = {
      session_pct: null,
      weekly_all: null,
      weekly_sonnet: null,
      weekly_opus: null,
      weekly_design: null,
      session_resets_in: null,
      weekly_resets_at: null,
      plan: null,
      ts: new Date().toISOString(),
      url: location.href,
    };

    // --- Primary: label-first scan ---
    // Find text-bearing elements and match against LABEL_MAP.
    // v2.7: allow startsWith() match (label may have "\nResets..." subtitle in textContent),
    // and use forward-sibling walk in pctFromLabelSpan (not ancestor querySelector).
    const labelKeys = Object.keys(LABEL_MAP);
    const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, span, p, div'));
    candidates.forEach(el => {
      // Only leaf-ish nodes to avoid huge container textContent
      if (el.children.length > 2) return;
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!txt) return;
      // Try exact match first, then startsWith (handles "current session\nresets in...")
      let matchedKey = LABEL_MAP[txt];
      if (!matchedKey) {
        for (const k of labelKeys) {
          if (txt.startsWith(k)) { matchedKey = LABEL_MAP[k]; break; }
        }
      }
      if (!matchedKey || result[matchedKey] != null) return;
      const pct = pctFromLabelSpan(el);
      if (pct != null) result[matchedKey] = pct;
    });

    // --- Fallback: progressbar scan (catches any missed bars) ---
    const bars = Array.from(document.querySelectorAll('[role="progressbar"]'));
    bars.forEach(bar => {
      const pct = parsePctFromAny(bar);
      if (pct == null) return;
      const key = classify(nearestLabelText(bar));
      if (key && result[key] == null) result[key] = pct;
    });

    // --- Last-resort: text scan for "X% used" near keyword ---
    if (result.session_pct == null || result.weekly_all == null) {
      const sections = document.querySelectorAll('section, [class*="usage"], [class*="quota"], li');
      sections.forEach(sec => {
        const txt = (sec.textContent || '');
        const m = txt.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
        if (!m) return;
        const key = classify(txt.toLowerCase());
        if (key && result[key] == null) result[key] = parseFloat(m[1]);
      });
    }

    const fullText = (document.body.innerText || '');
    const resetIn = fullText.match(/resets?\s+in\s+([^\n,.]{1,40})/i);
    if (resetIn) result.session_resets_in = resetIn[1].trim().replace(/\s+/g, ' ');
    const resetAt = fullText.match(/resets?\s+(?:at\s+)?(\d{1,2}:\d{2}[^\n,]{0,30})/i);
    if (resetAt) result.weekly_resets_at = resetAt[1].trim().replace(/\s+/g, ' ');

    const planMatch = fullText.match(/\b(Pro|Max\s*\$?\d*|Team|Enterprise|Free)\b/);
    if (planMatch) result.plan = planMatch[1].trim();

    return result;
  }

  // ---- POST to pl_server -----------------------------------------------------

  function postUsage(payload, onDone) {
    const body = JSON.stringify(payload);
    const hash = hashStr(body);
    if (hash === lastPayloadHash) {
      log('Skipping duplicate POST');
      onDone && onDone({ skipped: true });
      return;
    }
    lastPayloadHash = hash;
    GM_xmlhttpRequest({
      method: 'POST',
      url: INGEST,
      headers: { 'Content-Type': 'application/json' },
      data: body,
      timeout: 8000,
      onload: (r) => {
        try {
          const d = JSON.parse(r.responseText);
          log('Ingested:', d);
          try { localStorage.setItem(LS_LAST, JSON.stringify({ ...payload, _server_ack: true })); } catch (_) {}
          onDone && onDone({ ok: true, response: d });
        } catch (e) {
          log('Ingest response parse error:', r.responseText);
          onDone && onDone({ ok: false, error: 'parse' });
        }
      },
      onerror: (e) => {
        log('Ingest error (server down?):', e);
        try { localStorage.setItem(LS_LAST, JSON.stringify({ ...payload, _server_ack: false })); } catch (_) {}
        onDone && onDone({ ok: false, error: 'network' });
      },
      ontimeout: () => onDone && onDone({ ok: false, error: 'timeout' }),
    });
  }

  // ---- UI overlay ------------------------------------------------------------

  function fmtPct(v) { return v == null ? '—' : `${v.toFixed(0)}%`; }

  function ensureOverlay() {
    let box = document.getElementById('lg13-usage-overlay');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'lg13-usage-overlay';
    box.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;'
      + 'background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;'
      + 'padding:10px 14px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4);'
      + 'min-width:220px;cursor:pointer';
    box.title = 'Click to sync now';
    box.addEventListener('click', () => run(true));
    document.body.appendChild(box);
    return box;
  }

  function renderOverlay(payload, status) {
    const box = ensureOverlay();
    const tone = status && status.ok ? '#22c55e' : (status && status.skipped ? '#94a3b8' : '#ef4444');
    const sub = status && status.ok ? 'synced' : (status && status.skipped ? 'no change' : 'offline');
    box.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">`
      + `<strong>LG13 Usage</strong>`
      + `<span style="color:${tone};font-size:11px">●&nbsp;${sub}</span></div>`
      + `<div style="margin-top:6px">session: <strong>${fmtPct(payload.session_pct)}</strong>`
      + (payload.session_resets_in ? ` · resets ${payload.session_resets_in}` : '') + `</div>`
      + `<div>week: <strong>${fmtPct(payload.weekly_all)}</strong>`
      + (payload.weekly_opus != null ? ` · opus ${fmtPct(payload.weekly_opus)}` : '')
      + (payload.weekly_sonnet != null ? ` · son ${fmtPct(payload.weekly_sonnet)}` : '') + `</div>`
      + (payload.plan ? `<div style="opacity:.7">plan: ${payload.plan}</div>` : '')
      + `<div style="opacity:.5;font-size:10px;margin-top:4px">${new Date(payload.ts).toLocaleTimeString()}</div>`;
  }

  // ---- main loop -------------------------------------------------------------

  function run(force) {
    const payload = parseUsagePage();
    log('Parsed usage:', payload);
    if (force) lastPayloadHash = null;
    postUsage(payload, (status) => renderOverlay(payload, status));
  }

  const observer = new MutationObserver(() => {
    if (document.querySelector('[role="progressbar"], [class*="progress"], [class*="Progress"]')) {
      observer.disconnect();
      setTimeout(() => run(false), 1000);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  setInterval(() => run(false), POLL_MS);
  setTimeout(() => run(false), 2500);

})();
