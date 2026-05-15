// ==UserScript==
// @name         LG13 Claude Usage Monitor
// @namespace    lg13.local
// @version      3.6
// @description  Parse Claude usage page (session/weekly %, resets, plan, extra usage EUR) → POST localhost:8790/pl/usage/ingest. Auto page-reload. (#2687) [v3.4: extra usage EUR parsing (extra_spent_eur/extra_limit_eur/extra_balance_eur); v3.3: fix field mapping; v3.2: Chrome allowed; v3.1: Edge support; v3.0: container-first parser]
// @match        https://claude.ai/settings/usage*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_claude_usage.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_claude_usage.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- engine lock removed v3.2 — Chrome allowed ---------------------------
  // Tom directive 2026-05-13: TM musí běžet i v Chrome.
  // Duplicate POST ochrana: hash dedup (lastPayloadHash) filtruje stejná data.

  if (window.__LG13_USAGE__) return;
  window.__LG13_USAGE__ = true;

  const INGEST     = 'http://127.0.0.1:8790/pl/usage/ingest';
  const POLL_MS        = 2 * 60 * 1000; // re-parse + POST
  const REFRESH_MS_HI  = 1 * 60 * 1000; // extra usage or limit >= 80%
  const REFRESH_MS_LO  = 3 * 60 * 1000; // normal
  const LS_LAST    = 'lg13_usage_last';
  const log = (...a) => console.log('[LG13-USAGE]', ...a);

  let lastPayloadHash = null;
  let refreshTimer = null;

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

  function isProgressbar(el) {
    return el && el.getAttribute && el.getAttribute('role') === 'progressbar';
  }

  function nearestLabelText(el) {
    const ctx = el.closest('section, li, [class*="row"], [class*="usage"], [class*="quota"], [class*="card"], div');
    return ((ctx && ctx.textContent) || el.textContent || '').toLowerCase();
  }

  function classify(label) {
    if (!label) return null;
    if (/\bsession\b|\b5[\s-]?h\b|five[\s-]?hour/.test(label)) return 'session_pct';
    // all_models MUST come before sonnet — "All models" container may contain "Sonnet" in sublabels
    if (/\ball[\s-]?models\b/.test(label)) return 'weekly_all';
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

  // Map of normalized label text → result key.
  const LABEL_MAP = {
    'current session':    'session_pct',
    'session':            'session_pct',
    'all models':         'weekly_all',
    'all claude models':  'weekly_all',
    'sonnet only':        'weekly_sonnet',
    'claude sonnet':      'weekly_sonnet',
    'sonnet':             'weekly_sonnet',
    'opus only':          'weekly_opus',
    'claude opus':        'weekly_opus',
    'opus':               'weekly_opus',
    'claude design':      'weekly_design',
    'design':             'weekly_design',
    'artifacts':          'weekly_design',
  };
  const LABEL_KEYS = Object.keys(LABEL_MAP);

  // ---- parser (v2.8 positional zip-walk) -------------------------------------

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

    // Strategy 1 — container-first (v3.0).
    // claude.ai uses card/row containers where label and progressbar are siblings.
    // Walk each bar upward until we find a container with exactly 1 bar + a matching label.
    const claimedBars = new Set();
    const bars = Array.from(document.querySelectorAll('[role="progressbar"]'));

    bars.forEach(bar => {
      const pct = parsePctFromAny(bar);
      if (pct == null) return;
      let el = bar.parentElement;
      for (let depth = 0; depth < 9; depth++) {
        if (!el || el === document.body) break;
        // Skip containers that hold multiple bars (too broad).
        if (el.querySelectorAll('[role="progressbar"]').length > 1) {
          el = el.parentElement; continue;
        }
        // Prefer a short direct-child label element over full container text.
        // Full textContent may include sublabels (e.g. "All models ... Sonnet ... Opus") that
        // confuse classify() — use it only when no short child label is found.
        const labelEl = el.querySelector('h1,h2,h3,h4,h5,h6,strong,span,p,div');
        const labelElTxt = labelEl ? labelEl.textContent.trim().toLowerCase() : '';
        const txt = (labelElTxt && labelElTxt.length > 0 && labelElTxt.length <= 60)
          ? labelElTxt
          : (el.textContent || '').trim().toLowerCase();
        // Try exact LABEL_MAP match first.
        let key = LABEL_MAP[txt];
        if (!key) {
          for (const k of LABEL_KEYS) {
            if (txt === k || txt.startsWith(k + '\n') || txt.startsWith(k + ' ') || txt.includes('\n' + k)) {
              key = LABEL_MAP[k]; break;
            }
          }
        }
        // Fallback classify by keyword.
        if (!key) key = classify(txt);
        if (key && result[key] == null) {
          result[key] = pct;
          claimedBars.add(bar);
          break;
        }
        el = el.parentElement;
      }
    });

    // Strategy 2 — positional zip-walk for any bars still unclaimed.
    // Handles edge cases where container approach misses (no wrapping element).
    const all = Array.from(document.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, strong, span, p, div, [role="progressbar"]'
    ));
    const labelHits = [];
    const barIdxs   = [];
    const seenKey   = new Set();
    all.forEach((el, idx) => {
      if (isProgressbar(el)) { barIdxs.push(idx); return; }
      if (el.children.length > 2) return;
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!txt || txt.length > 80) return;
      let matchedKey = LABEL_MAP[txt];
      if (!matchedKey) {
        for (const k of LABEL_KEYS) {
          if (txt === k || txt.startsWith(k + '\n') || txt.startsWith(k + ' ')) {
            matchedKey = LABEL_MAP[k]; break;
          }
        }
      }
      if (!matchedKey) return;
      if (seenKey.has(matchedKey)) return;
      seenKey.add(matchedKey);
      labelHits.push({ idx, key: matchedKey });
    });
    // Forward walk (label before bar).
    labelHits.forEach(hit => {
      if (result[hit.key] != null) return; // already claimed by container pass
      for (const bIdx of barIdxs) {
        if (bIdx <= hit.idx) continue;
        const bar2 = all[bIdx];
        if (claimedBars.has(bar2)) continue;
        const pct = parsePctFromAny(bar2);
        if (pct == null) continue;
        result[hit.key] = pct;
        claimedBars.add(bar2);
        break;
      }
    });
    // Backward walk (bar before label) — handles new DOM order.
    labelHits.forEach(hit => {
      if (result[hit.key] != null) return;
      for (let i = barIdxs.length - 1; i >= 0; i--) {
        const bIdx = barIdxs[i];
        if (bIdx >= hit.idx) continue;
        const bar2 = all[bIdx];
        if (claimedBars.has(bar2)) continue;
        const pct = parsePctFromAny(bar2);
        if (pct == null) continue;
        result[hit.key] = pct;
        claimedBars.add(bar2);
        break;
      }
    });

    // Fallback — any leftover bar gets classified by nearby textual context.
    barIdxs.forEach(bIdx => {
      const bar2 = all[bIdx];
      if (claimedBars.has(bar2)) return;
      const pct = parsePctFromAny(bar2);
      if (pct == null) return;
      const key = classify(nearestLabelText(bar2));
      if (key && result[key] == null) {
        result[key] = pct;
        claimedBars.add(bar2);
      }
    });

    // Last-resort text scan for any still-null primary fields.
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
    if (resetIn) { result.session_resets_in = resetIn[1].trim().replace(/\s+/g, ' '); result.session_resets_captured_at = new Date().toISOString(); }
    const resetAt = fullText.match(/resets?\s+(?:at\s+)?(\d{1,2}:\d{2}[^\n,]{0,30})/i);
    if (resetAt) result.weekly_resets_at = resetAt[1].trim().replace(/\s+/g, ' ');

    const planMatch = fullText.match(/\b(Pro|Max\s*\$?\d*|Team|Enterprise|Free)\b/);
    if (planMatch) result.plan = planMatch[1].trim();

    // Extra usage billing (EUR) — "€47.65 spent", "€50 Monthly spend limit", "Current balance €15.01"
    const eurNum = s => parseFloat(s.replace(/,/g, '.'));
    const mSpent = fullText.match(/€\s*([\d,]+\.?\d*)\s*spent/i);
    if (mSpent) result.extra_spent_eur = eurNum(mSpent[1]);
    const mLimit = fullText.match(/€\s*([\d,]+\.?\d*)\s*[Mm]onthly\s*spend\s*limit/i);
    if (mLimit) result.extra_limit_eur = eurNum(mLimit[1]);
    const mBalance = fullText.match(/[Cc]urrent\s*balance\s*[:\s]*€\s*([\d,]+\.?\d*)/i);
    if (mBalance) result.extra_balance_eur = eurNum(mBalance[1]);
    const mExtraResets = fullText.match(/[Rr]esets\s+([A-Z][a-z]{2}\s+\d{1,2})/);
    if (mExtraResets) result.extra_resets_at = mExtraResets[1].trim();

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
      + 'min-width:240px;cursor:pointer';
    box.title = 'Click to sync now · double-click to reload page';
    box.addEventListener('click', () => run(true));
    box.addEventListener('dblclick', (e) => { e.preventDefault(); location.reload(); });
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
      + (payload.weekly_sonnet != null ? ` · son ${fmtPct(payload.weekly_sonnet)}` : '')
      + (payload.weekly_opus   != null ? ` · opus ${fmtPct(payload.weekly_opus)}` : '')
      + (payload.weekly_design != null ? ` · des ${fmtPct(payload.weekly_design)}` : '')
      + `</div>`
      + (payload.plan ? `<div style="opacity:.7">plan: ${payload.plan}</div>` : '')
      + (payload.extra_spent_eur != null ? (() => {
          const pct = payload.extra_limit_eur > 0 ? Math.round(payload.extra_spent_eur / payload.extra_limit_eur * 100) : '?';
          const bal = payload.extra_balance_eur != null ? ` · bal €${payload.extra_balance_eur.toFixed(2)}` : '';
          return `<div style="opacity:.85;color:#f59e0b">extra: ${pct}% (€${payload.extra_spent_eur.toFixed(2)}/€${payload.extra_limit_eur ?? '?'})${bal}</div>`;
        })() : '')
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

  // Hard reload — claude.ai refetches usage on full page load.
  // 1min if extra usage active or 5h/week >= 80%, else 3min.
  if (refreshTimer) clearTimeout(refreshTimer);
  const _hi = (refreshTimer => {
    const p = parseUsagePage();
    const onExtra = p.extra_spent_eur != null && p.extra_limit_eur > 0;
    const highLoad = (p.session_pct >= 80) || (p.weekly_all >= 80);
    return onExtra || highLoad;
  })();
  const _delay = _hi ? REFRESH_MS_HI : REFRESH_MS_LO;
  refreshTimer = setTimeout(() => {
    log('Auto-reloading page after', _delay / 1000, 's');
    location.reload();
  }, _delay);

})();
