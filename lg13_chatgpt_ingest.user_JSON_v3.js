// ==UserScript==
// @name         ChatGPT → LG13 Ingest (JSON v3 incremental)
// @namespace    lg13.local
// @version      3.2
// @description  Incremental structured ingest with logging & dedup
// @author       Tom / LG13
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';
if (window.__LG13_RUNNING__) {
  console.log('[LG13] already running → skip init');
  return;
}
window.__LG13_RUNNING__ = true;
  const LG13_URL = 'http://127.0.0.1:8790/pl/chatgpt/ingest';
  const DEBOUNCE_MS = 2000;
  const SEEN_KEY = 'lg13_seen_hashes_v3';
  const DEBUG = true;

  // ── LOGGING ───────────────────────────────────────
  const log = (...a) => DEBUG && console.log('[LG13]', ...a);
  const err = (...a) => console.error('[LG13-ERR]', ...a);

  let stats = {
    processed: 0,
    sent: 0,
    skipped: 0,
    errors: 0
  };

  // ── UTILS ─────────────────────────────────────────
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function getMsgHash(msg) {
    return hashStr(msg.role + '|' + msg.text.slice(0, 500));
  }

  function loadSeen() {
    try {
      return JSON.parse(GM_getValue(SEEN_KEY, '[]'));
    } catch {
      return [];
    }
  }

  function saveSeen(arr) {
    GM_setValue(SEEN_KEY, JSON.stringify(arr.slice(-500)));
  }

  function getConvId() {
    const m = location.href.match(/\/c\/([a-f0-9-]{36})/);
    return m ? m[1] : '';
  }

  function getConvTitle() {
    const t = document.title || '';
    return t === 'ChatGPT' ? '' : t;
  }

  // ── TEXT EXTRACTION ───────────────────────────────
  function extractText(el) {
    if (!el) return '';

    const clone = el.cloneNode(true);

    clone.querySelectorAll('button, svg, img').forEach(n => n.remove());

    clone.querySelectorAll('br').forEach(b =>
      b.replaceWith(document.createTextNode('\n'))
    );

    clone.querySelectorAll('p, div, li, h1, h2, h3, pre, blockquote')
      .forEach(b => b.insertAdjacentText('beforebegin', '\n'));

    return (clone.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  // ── EXTRACTION ────────────────────────────────────
  function extractConversationJSON() {
    const turns = document.querySelectorAll('[data-message-author-role]');
    if (!turns.length) return null;

    const messages = [];
    let idx = 0;

    turns.forEach(el => {
      try {
        const role = el.getAttribute('data-message-author-role');
        const text = extractText(el);

        if (!text || text.length < 5) return;

        messages.push({
          id: `${idx}`,
          idx,
          role: role === 'user' ? 'user' : 'assistant',
          text,
          ts: new Date().toISOString(),

          tags: [],
          type: null,
          atoms: []
        });

        idx++;
      } catch (e) {
        stats.errors++;
        err('extract message failed', e);
      }
    });

    return {
      meta: {
        conv_id: getConvId(),
        title: getConvTitle(),
        url: location.href,
        captured_at: new Date().toISOString()
      },
      messages
    };
  }

  // ── SEND ──────────────────────────────────────────
  function sendToLG13(messages, meta) {
    if (!messages.length) return;

    const payload = {
      meta,
      messages
    };

    const raw = JSON.stringify(payload);

    GM_xmlhttpRequest({
      method: 'POST',
      url: LG13_URL,
      headers: { 'Content-Type': 'application/json' },
      data: raw,

      onload(resp) {
        stats.sent += messages.length;
        log('Sent:', messages.length);

        try {
          const d = JSON.parse(resp.responseText);
          showStatus(d.ok ? `✓ ${messages.length}` : '⚠ err');
        } catch {
          showStatus('⚠ parse');
        }
      },

      onerror(e) {
        stats.errors++;
        err('HTTP error', e);
        showStatus('⚠ offline');
      }
    });
  }

  // ── UI ────────────────────────────────────────────
  let statusEl, timer;

  function buildUI() {
    const btn = document.createElement('button');
    btn.textContent = '⬡ LG13';

    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '60px',
      right: '16px',
      zIndex: 999999,
      fontSize: '11px'
    });

    btn.onclick = () => {
      try {
        const data = extractConversationJSON();
        if (!data) return showStatus('nic');

        sendToLG13(data.messages, data.meta);
        showStatus('⏳ manual');

      } catch (e) {
        stats.errors++;
        err('manual send failed', e);
      }
    };

    document.body.appendChild(btn);

    statusEl = document.createElement('div');

    Object.assign(statusEl.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      fontSize: '11px',
      zIndex: 999999
    });

    document.body.appendChild(statusEl);
  }

  function showStatus(msg) {
    statusEl.textContent = `LG13 ${msg}`;
    clearTimeout(timer);
   timer = setTimeout(() => {
  statusEl.textContent = '';
}, 3000);
  }

  // ── STREAM CHECK ──────────────────────────────────
  function isStreaming() {
    return !!document.querySelector('[data-testid="stop-button"]');
  }

  // ── CHANGE HANDLER (INCREMENTAL) ──────────────────
  function onChange() {
    if (isStreaming()) return;

    try {
      const data = extractConversationJSON();
      if (!data) return;

      const seen = loadSeen();
      const newMsgs = [];

      data.messages.forEach(msg => {
        const h = getMsgHash(msg);

        if (!seen.includes(h)) {
          newMsgs.push(msg);
          seen.push(h);
        } else {
          stats.skipped++;
        }
      });

      if (!newMsgs.length) {
        log('No new messages');
        return;
      }

      saveSeen(seen);

      stats.processed += newMsgs.length;
      log('New messages:', newMsgs.length);

      sendToLG13(newMsgs, data.meta);

    } catch (e) {
      stats.errors++;
      err('onChange failed', e);
    }
  }

  // ── OBSERVER ──────────────────────────────────────
  let debounceTimer = null;

  function init() {
    buildUI();

    const obs = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(onChange, DEBOUNCE_MS);
    });

    obs.observe(document.body, {
      childList: true,
      subtree: true
    });

    log('LG13 ingest started');
  }

  // ── DEBUG ACCESS ──────────────────────────────────
  window.LG13_DEBUG = () => {
    console.log('STATS:', stats);
    console.log('SEEN:', loadSeen().length);
  };

  init();

})();
