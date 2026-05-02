// ==UserScript==
// @name         ChatGPT → LG13 Ingest
// @namespace    lg13.local
// @version      1.6
// @description  Auto-captures ChatGPT conversations and sends to local LG13 system (pl_server:8790). v1.6: fix user-select:none on assistant messages (was capturing only user turns).
// @author       Tom / LG13
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==
(function() {
  'use strict';
  const LG13_URL    = 'http://127.0.0.1:8790/pl/chatgpt/ingest';
  const DEBOUNCE_MS = 3000;
  const MIN_CHARS   = 200;
  const SEEN_KEY    = 'lg13_seen_hashes';

  // ── Utilities ──────────────────────────────────────────────────────────────
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
  function loadSeen() { try { return JSON.parse(GM_getValue(SEEN_KEY, '[]')); } catch { return []; } }
  function saveSeen(arr) { GM_setValue(SEEN_KEY, JSON.stringify(arr.slice(-200))); }

  // ── Extract conv_id from URL ───────────────────────────────────────────────
  function getConvId() {
    const m = location.href.match(/\/c\/([a-f0-9-]{36})/);
    return m ? m[1] : '';
  }

  // ── Extract conversation title from page ───────────────────────────────────
  function getConvTitle() {
    // document.title is like "Luky's Game 13 - Thread Name" or just "ChatGPT"
    let title = document.title || '';
    // Strip "ChatGPT" if it's just that
    if (title === 'ChatGPT' || title === 'chatgpt.com') return '';
    return title;
  }

  // ── Extract text from a turn element ───────────────────────────────────────
  // innerText mimics "select + copy" and respects CSS user-select:none,
  // which ChatGPT applies to assistant messages — so innerText returns empty
  // and [ChatGPT]: blocks disappeared. Use textContent on a clone where we
  // inject newlines around block-level elements to preserve readable output.
  function extractText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    // Strip buttons/icons/avatars that would add noise
    clone.querySelectorAll('button, svg, img').forEach(n => n.remove());
    // Convert <br> to newline
    clone.querySelectorAll('br').forEach(b => b.replaceWith(document.createTextNode('\n')));
    // Block-level → prefix newline so paragraphs/lists stay readable
    clone.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr, hr').forEach(b => {
      b.insertAdjacentText('beforebegin', '\n');
    });
    return (clone.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  // ── Extract conversation ────────────────────────────────────────────────────
  function extractConversation() {
    const turns = document.querySelectorAll('[data-message-author-role]');
    if (!turns.length) return null;
    const lines = [];

    // Add metadata header
    const convId = getConvId();
    const convTitle = getConvTitle();
    const url = location.href;
    lines.push(`[META] conv_id: ${convId}`);
    lines.push(`[META] title: ${convTitle}`);
    lines.push(`[META] url: ${url}`);
    lines.push(`[META] captured: ${new Date().toISOString()}`);
    lines.push('---');

    turns.forEach(el => {
      const role  = el.getAttribute('data-message-author-role');
      const label = role === 'user' ? 'Ty' : 'ChatGPT';
      const text  = extractText(el);
      if (text) lines.push(`[${label}]: ${text}`);
    });
    return lines.join('\n\n');
  }

  // ── Send to LG13 ───────────────────────────────────────────────────────────
  function sendToLG13(text) {
    const h = hashStr(text);
    const seen = loadSeen();
    if (seen.includes(h)) return;
    seen.push(h);
    saveSeen(seen);

    const convId = getConvId();
    const convTitle = getConvTitle();

    GM_xmlhttpRequest({
      method: 'POST',
      url: LG13_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        text,
        source: 'tampermonkey',
        url: location.href,
        ts: new Date().toISOString(),
        conv_id: convId,
        conv_name: convTitle,
      }),
      onload(resp) {
        try {
          const d = JSON.parse(resp.responseText);
          showStatus(d.ok ? `✓ ${d.bytes}B` : '⚠ err', d.ok ? '#4ade80' : '#fb923c');
        } catch { showStatus('⚠ ?', '#fb923c'); }
      },
      onerror() {
        // Fallback: save locally if server is offline
        showStatus('⚠ offline', '#f87171');
      },
    });
  }

  // ── Shadow DOM UI ──────────────────────────────────────────────────────────
  let shadow = null;
  let statusEl = null;
  let statusTimer = null;
  function buildUI() {
    if (shadow) return;
    const host = document.createElement('div');
    host.id = 'lg13-shadow-host';
    Object.assign(host.style, {
      position: 'fixed',
      bottom: '0',
      right: '0',
      width: '0',
      height: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      overflow: 'visible',
    });
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        #btn {
          position: fixed;
          bottom: 60px;
          right: 16px;
          z-index: 2147483647;
          background: #07101e;
          border: 1px solid #1e3358;
          color: #4b8ef5;
          padding: 5px 10px;
          border-radius: 6px;
          font-size: 11px;
          cursor: pointer;
          font-family: monospace;
          font-weight: 600;
          box-shadow: 0 2px 8px rgba(0,0,0,.6);
          pointer-events: auto;
          user-select: none;
        }
        #btn:hover { background: #0d1f3c; border-color: #4b8ef5; }
        #status {
          position: fixed;
          bottom: 16px;
          right: 16px;
          z-index: 2147483647;
          padding: 5px 10px;
          border-radius: 6px;
          font-size: 11px;
          font-family: monospace;
          font-weight: 600;
          background: #052e16;
          border: 1px solid #16a34a;
          color: #4ade80;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.3s;
        }
      </style>
      <button id="btn">⬡ LG13</button>
      <div id="status"></div>
    `;
    statusEl = shadow.getElementById('status');
    shadow.getElementById('btn').addEventListener('click', () => {
      const text = extractConversation();
      if (!text || text.length < MIN_CHARS) { showStatus('nic k odeslání', '#fb923c'); return; }
      const h = hashStr(text);
      saveSeen(loadSeen().filter(x => x !== h));
      sendToLG13(text);
      showStatus('⏳ odesílám…', '#4ade80');
    });
  }
  function showStatus(msg, color = '#4ade80') {
    if (!shadow) return;
    const el = shadow.getElementById('status');
    if (!el) return;
    el.textContent = `⬡ LG13 ${msg}`;
    el.style.color = color;
    el.style.opacity = '1';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  // ── Auto-capture ───────────────────────────────────────────────────────────
  let debounceTimer = null;
  let lastAssistantMsg = '';
  function isStreaming() {
    return !!(
      document.querySelector('[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label="Stop streaming"]') ||
      document.querySelector('.result-streaming')
    );
  }
  function onDomChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (isStreaming()) return;
      const text = extractConversation();
      if (!text || text.length < MIN_CHARS) return;
      const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastMsg = turns.length ? extractText(turns[turns.length - 1]) : '';
      if (lastMsg === lastAssistantMsg) return;
      lastAssistantMsg = lastMsg;
      sendToLG13(text);
    }, DEBOUNCE_MS);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    buildUI();
    showStatus('připojen', '#4ade80');
    const observer = new MutationObserver(onDomChange);
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (!document.getElementById('lg13-shadow-host')) {
        shadow = null;
        statusEl = null;
        buildUI();
        showStatus('obnoveno', '#4ade80');
      }
    }, 3000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
