// ==UserScript==
// @name         NALUS → LG13 Ingest
// @namespace    lg13.local
// @version      1.0
// @description  Captures currently viewed nalus.usoud.cz judikat/vysledek page and sends to LG13 pl_server atom pipeline (same schema as ChatGPT/Gemini ingest).
// @author       Tom / LG13
// @match        https://nalus.usoud.cz/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_nalus_ingest.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_nalus_ingest.user.js
// ==/UserScript==
(function() {
  'use strict';

  const LG13_URL    = 'http://127.0.0.1:8790/pl/nalus/ingest';
  const SEEN_KEY     = 'lg13_nalus_seen';
  const MIN_TEXT_LEN = 200; // below this, page is likely a search form / listing, not a result

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function loadSeen() { try { return JSON.parse(GM_getValue(SEEN_KEY, '{}')); } catch { return {}; } }
  function saveSeen(o) { GM_setValue(SEEN_KEY, JSON.stringify(o)); }

  // NALUS URLs vary by page (ResultDetail / GetText / Search); try common id-bearing
  // query params first, fall back to a hash of href+title so re-visits still dedup.
  function getConvId() {
    const params = new URLSearchParams(location.search);
    for (const key of ['id', 'iddoc', 'JudgmentId', 'sp_zn', 'spzn', 'Id_' ]) {
      const v = params.get(key);
      if (v) return 'nalus_' + hashStr(key + '|' + v).slice(0, 12);
    }
    return 'nalus_' + hashStr(location.pathname + '|' + location.search);
  }

  function getTitle() {
    return (document.title || '').trim();
  }

  // Strip common site chrome from a clone (never mutate the live DOM — MutationObserver gotcha).
  function extractPageText() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(
      'script, style, nav, header, footer, ' +
      '[class*="menu" i], [class*="nav" i], [class*="header" i], [class*="footer" i], ' +
      '[class*="cookie" i], [id*="menu" i], [id*="nav" i], [id*="header" i], [id*="footer" i]'
    ).forEach(n => n.remove());
    clone.querySelectorAll('br').forEach(b => b.replaceWith(document.createTextNode('\n')));
    clone.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr').forEach(b => {
      b.insertAdjacentText('beforebegin', '\n');
    });
    return (clone.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  // ── Status badge ──────────────────────────────────────────────────────────
  let badge = null;
  let badgeTimer = null;
  function showStatus(text, color) {
    if (!badge) {
      badge = document.createElement('div');
      Object.assign(badge.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
        padding: '4px 10px', borderRadius: '6px', fontSize: '11px',
        fontFamily: 'monospace', fontWeight: '600', pointerEvents: 'none',
        transition: 'opacity .3s',
      });
      document.body.appendChild(badge);
    }
    badge.textContent = '⚡ LG13 NALUS ' + text;
    badge.style.background = color;
    badge.style.color = '#fff';
    badge.style.opacity = '1';
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => { if (badge) badge.style.opacity = '0'; }, 3000);
  }

  // ── Capture button ────────────────────────────────────────────────────────
  function addButton() {
    if (document.getElementById('lg13-nalus-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'lg13-nalus-btn';
    btn.textContent = 'NALUS → LG13';
    Object.assign(btn.style, {
      position: 'fixed', bottom: '40px', right: '16px', zIndex: '2147483647',
      padding: '6px 10px', borderRadius: '6px', fontSize: '11px',
      fontFamily: 'monospace', fontWeight: '600', cursor: 'pointer',
      background: '#1e293b', color: '#fff', border: '1px solid #475569',
    });
    btn.addEventListener('click', () => sendToLG13(true));
    document.body.appendChild(btn);
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  function sendToLG13(manual) {
    const convId = getConvId();
    const text = extractPageText();
    if (text.length < MIN_TEXT_LEN) {
      if (manual) showStatus('nic k odeslani (kratky text)', '#7f1d1d');
      return;
    }

    const fp = hashStr(text);
    const seen = loadSeen();
    if (!manual && seen[convId] === fp) return;

    const payload = {
      meta: {
        schema: 'lg13.nalus.v1',
        conv_id: convId,
        title: getTitle(),
        url: location.href,
        captured_at: new Date().toISOString(),
        fingerprint: fp,
        source: 'nalus',
        api: null,
      },
      messages: [{
        id: 'nalus_' + hashStr(convId + '|' + fp),
        idx: 0,
        role: 'assistant',
        content: text,
        text: text,
        ts: new Date().toISOString(),
        ts_source: 'dom',
      }],
    };

    showStatus('odesilam...', '#4ade80');
    GM_xmlhttpRequest({
      method: 'POST',
      url: LG13_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload),
      timeout: 8000,
      onload(resp) {
        try {
          const d = JSON.parse(resp.responseText);
          if (d.ok && !d.skipped) {
            seen[convId] = fp;
            saveSeen(seen);
            showStatus('✓ zachyceno' + (d.new_atoms != null ? ' (+' + d.new_atoms + ' atoms)' : ''), '#166534');
          } else if (d.skipped) {
            seen[convId] = fp;
            saveSeen(seen);
            showStatus('= beze zmeny', '#374151');
          } else {
            showStatus('⚠ ' + (d.error || 'err'), '#7f1d1d');
          }
        } catch { showStatus('⚠ parse', '#7f1d1d'); }
      },
      onerror() { showStatus('⚠ offline', '#374151'); },
      ontimeout() { showStatus('⚠ timeout', '#374151'); },
    });
  }

  function init() {
    addButton();
    // Auto-trigger once page has settled (non-blocking, silent if page isn't a result).
    setTimeout(() => sendToLG13(false), 1500);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
