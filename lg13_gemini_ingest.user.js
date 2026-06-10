// ==UserScript==
// @name         Gemini -> LG13 Ingest
// @namespace    lg13.local
// @version      1.2
// @description  v1.2: strict @match (app/* only, fixes firing on static/home pages). DOM-only ingest for Google Gemini.
// @author       Tom / LG13
// @match        https://gemini.google.com/app/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_gemini_ingest.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_gemini_ingest.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__LG13_GEMINI_RUNNING__) return;
  window.__LG13_GEMINI_RUNNING__ = true;

  var GLYPH_HEX = String.fromCodePoint(0x2B21);
  var GLYPH_OK  = String.fromCodePoint(0x2713);
  var GLYPH_WRN = String.fromCodePoint(0x26A0);
  var GLYPH_HRG = String.fromCodePoint(0x23F3);

  const LG13_URL       = 'http://127.0.0.1:8790/pl/gemini/ingest';
  const DEBOUNCE_MS    = 2000;
  const SCHEMA_VERSION = 'lg13.v1.gemini';
  const VERSION        = '1.0';

  const log = (...a) => console.log('[LG13-GEM]', ...a);
  const err = (...a) => console.error('[LG13-GEM-ERR]', ...a);

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function getConvId() {
    const m = location.href.match(/\/app\/([a-f0-9]+)/i);
    if (m) return m[1];
    const seed = (document.title || '') + (document.body.innerText.slice(0, 500) || '');
    return 'fallback_' + hashStr(seed);
  }

  function getConvTitle() {
    const t = document.title || '';
    return t.replace(/\s*[-–]\s*Google Gemini\s*$/i, '').trim();
  }

  // ---- LG13_META trailer (same protocol as ChatGPT ingest) -----------------
  const LG13_KEY_ALIAS = {
    th: 'thread',   tp: 'topic',      tg: 'tags',
    rf: 'refs',     ab: 'atom_break', fu: 'followup',
    ly: 'layer',    li: 'legal_intent', ah: 'atom_hint',
    st: 'story_id', rk: 'risk'
  };

  function extractLg13Meta(rawText) {
    if (!rawText) return null;
    const m = rawText.match(/<<LG13_META>>([\s\S]*?)<<\/LG13_META>>/);
    if (!m) return null;
    const body = m[1];
    const meta = {};
    body.split('\n').forEach(line => {
      const mm = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
      if (!mm) return;
      const rawKey = mm[1];
      const realKey = LG13_KEY_ALIAS[rawKey] || rawKey;
      let v = mm[2];
      if (v === '') return;
      if (v === 'true' || v === 'false') { meta[realKey] = (v === 'true'); return; }
      if (/^-?\d+$/.test(v)) { meta[realKey] = parseInt(v, 10); return; }
      if (v.startsWith('[')) {
        try { meta[realKey] = JSON.parse(v); return; }
        catch (_) {
          const inner = v.replace(/^\[/, '').replace(/\]\s*$/, '');
          meta[realKey] = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(s => s.length);
          return;
        }
      }
      v = v.replace(/^["']|["']$/g, '');
      meta[realKey] = v;
    });
    return Object.keys(meta).length ? meta : null;
  }

  function stripLg13Trailer(text) {
    if (!text) return text;
    let t = text.replace(
      /(?:\n?---\s*\n)?```[a-z]*\s*\n[\s\S]*?<<LG13_META>>[\s\S]*?<<\/LG13_META>>[\s\S]*?```\s*$/,
      ''
    );
    t = t.replace(
      /(?:\n?---\s*\n)?<!--\s*[\s\S]*?<<LG13_META>>[\s\S]*?<<\/LG13_META>>[\s\S]*?-->\s*$/,
      ''
    );
    t = t.replace(
      /(?:\n?---\s*\n)?<<LG13_META>>[\s\S]*?<<\/LG13_META>>\s*$/,
      ''
    );
    return t.trim();
  }

  function splitLg13Atoms(text) {
    if (!text) return null;
    const parts = text.split(/\n\s*\[\[ATOM\]\]\s*\n/);
    if (parts.length <= 1) return null;
    const out = parts.map(p => p.trim()).filter(p => p.length > 0);
    return out.length > 1 ? out : null;
  }

  // ---- DOM timestamps -------------------------------------------------------
  function extractTurnTimestamp(el) {
    const timeEl = el.querySelector('time[datetime]');
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime');
      if (dt) {
        const parsed = new Date(dt);
        if (!isNaN(parsed.getTime())) return { ts: parsed.toISOString(), ts_source: 'dom' };
      }
    }
    return { ts: new Date().toISOString(), ts_source: 'capture' };
  }

  // ---- text extraction from Gemini DOM -------------------------------------
  function extractUserText(el) {
    // Try .query-text-line paragraphs first (most reliable)
    const lines = el.querySelectorAll('.query-text-line');
    if (lines.length) {
      return Array.from(lines).map(p => p.textContent || '').join('\n').trim();
    }
    // Fallback: user-query-content innerText
    const uqc = el.querySelector('user-query-content');
    if (uqc) {
      const clone = uqc.cloneNode(true);
      clone.querySelectorAll('button, svg, .screen-reader-user-query-label').forEach(n => n.remove());
      return (clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }
    return (el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractModelText(el) {
    // Primary: .markdown.markdown-main-panel div
    const md = el.querySelector('.markdown.markdown-main-panel');
    if (md) {
      const clone = md.cloneNode(true);
      clone.querySelectorAll('button, svg').forEach(n => n.remove());
      clone.querySelectorAll('br').forEach(b => b.replaceWith(document.createTextNode('\n')));
      clone.querySelectorAll('p, div, li, h1, h2, h3, pre, blockquote')
        .forEach(b => b.insertAdjacentText('beforebegin', '\n'));
      return (clone.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
    }
    // Fallback: message-content element
    const mc = el.querySelector('message-content');
    if (mc) {
      return (mc.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }
    return '';
  }

  // ---- message ID from model-response --------------------------------------
  function getMessageId(el, role, text) {
    // model-response has <message-content id="message-content-id-r_<hash>">
    const mc = el.querySelector('[id^="message-content-id-r_"]');
    if (mc) return mc.id.replace('message-content-id-r_', '');
    // Fallback: hash of role + text
    return hashStr(role + '|' + text);
  }

  // ---- build conversation from DOM -----------------------------------------
  function extractConversation() {
    // Select all turns in document order
    const turns = document.querySelectorAll('user-query, model-response');
    if (!turns.length) return { messages: [] };

    const messages = [];
    let idx = 0;

    turns.forEach(el => {
      const tagName = el.tagName.toLowerCase();
      const role = tagName === 'user-query' ? 'user' : 'assistant';

      const rawText = role === 'user' ? extractUserText(el) : extractModelText(el);
      if (!rawText || rawText.length < 3) return;

      const lg13_meta  = extractLg13Meta(rawText);
      const cleanText  = stripLg13Trailer(rawText);
      const lg13_atoms = splitLg13Atoms(cleanText);
      const id         = getMessageId(el, role, cleanText);

      const { ts, ts_source } = extractTurnTimestamp(el);

      messages.push({
        id:          id,
        idx:         idx,
        role:        role,
        text:        cleanText,
        lg13_meta:   lg13_meta,
        lg13_atoms:  lg13_atoms,
        ts:          ts,
        ts_source:   ts_source,
        images:      []
      });
      idx++;
    });

    return { messages };
  }

  function getFingerprint(messages) {
    return hashStr(messages.map(m => m.id).join('|'));
  }

  // ---- streaming detection -------------------------------------------------
  function isStreaming() {
    // Gemini shows aria-busy="true" on the markdown panel while generating
    const busy = document.querySelector('[aria-busy="true"]');
    if (busy) return true;
    // Also check for the stop button
    const stopBtn = document.querySelector('[aria-label="Stop response"], [data-mat-icon-name="stop"]');
    return !!stopBtn;
  }

  // ---- send ----------------------------------------------------------------
  function send(messages, manual) {
    if (!messages || !messages.length) {
      if (manual) showStatus('nic k odeslani', '#fb923c');
      return;
    }
    const meta = {
      schema:       SCHEMA_VERSION,
      conv_id:      getConvId(),
      title:        getConvTitle(),
      url:          location.href,
      captured_at:  new Date().toISOString(),
      fingerprint:  getFingerprint(messages),
      source:       'gemini'
    };
    const payload    = JSON.stringify({ meta: meta, messages: messages });
    const metaCount  = messages.reduce((s, m) => s + (m.lg13_meta ? 1 : 0), 0);
    const tail       = metaCount ? ' [meta:' + metaCount + ']' : '';
    showStatus(GLYPH_HRG + ' odesilam...', '#4ade80');

    function onSuccess(respText) {
      log('sent', messages.length, 'meta:', metaCount);
      let diffStr = ' (+? new)';
      let color = '#4ade80';
      try {
        const d = JSON.parse(respText);
        if (d && d.skipped === 'fingerprint_match') {
          diffStr = ' (+0 new, dup)'; color = '#888';
        } else if (d && d.skipped === 'no_new_msgs') {
          diffStr = ' (+0 new)'; color = '#aaa';
        } else if (d && d.new_messages != null) {
          diffStr = d.new_messages === 0 ? ' (+0 new)' : ' (+' + d.new_messages + ' new)';
        }
      } catch (_) {}
      showStatus(GLYPH_OK + ' ' + messages.length + ' msgs' + diffStr + tail, color);
    }

    function sendViaFetch() {
      fetch(LG13_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }).then(r => r.text()).then(onSuccess).catch(e => {
        err('fetch fallback failed', e);
        showStatus(GLYPH_WRN + ' err(fetch)', '#f87171');
      });
    }

    try {
      GM_xmlhttpRequest({
        method:   'POST',
        url:      LG13_URL,
        headers:  { 'Content-Type': 'application/json' },
        data:     payload,
        timeout:  8000,
        onload:   (resp) => onSuccess(resp.responseText),
        onerror:  (e) => { err('GM err, trying fetch', e); sendViaFetch(); },
        ontimeout: () => { err('GM timeout, trying fetch'); sendViaFetch(); }
      });
    } catch (e) {
      err('GM_xmlhttpRequest threw, trying fetch', e);
      sendViaFetch();
    }
  }

  // ---- shadow-DOM toast UI -------------------------------------------------
  let shadow = null;
  let statusTimer = null;

  function buildUI() {
    if (shadow) return;
    const host = document.createElement('div');
    host.id = 'lg13-gem-shadow-host';
    Object.assign(host.style, {
      position: 'fixed', bottom: '0', right: '0', width: '0', height: '0',
      zIndex: '2147483647', pointerEvents: 'none', overflow: 'visible'
    });
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '#btn { position: fixed; bottom: 160px; right: 16px; z-index: 2147483647;',
      '       background: #07101e; border: 1px solid #1e3358; color: #4b8ef5;',
      '       padding: 5px 10px; border-radius: 6px; font-size: 11px;',
      '       cursor: pointer; font-family: monospace; font-weight: 600;',
      '       box-shadow: 0 2px 8px rgba(0,0,0,.6); pointer-events: auto;',
      '       user-select: none; }',
      '#btn:hover { background: #0d1f3c; border-color: #4b8ef5; }',
      '#status { position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;',
      '          padding: 4px 10px; border-radius: 6px; font-size: 10px;',
      '          font-family: monospace; font-weight: 600;',
      '          background: #1a1a1a; border: 1px solid #444; color: #888;',
      '          pointer-events: none; opacity: 1; transition: opacity 0.5s;',
      '          white-space: nowrap; }'
    ].join('\n');
    shadow.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'btn';
    btn.textContent = GLYPH_HEX + ' LG13-GEM v' + VERSION;
    btn.addEventListener('click', () => {
      const r = extractConversation();
      send(r.messages, true);
    });
    shadow.appendChild(btn);

    const status = document.createElement('div');
    status.id = 'status';
    shadow.appendChild(status);
  }

  function showStatus(msg, color) {
    if (!shadow) return;
    const el = shadow.getElementById('status');
    if (!el) return;
    el.textContent = GLYPH_HEX + ' LG13-GEM v' + VERSION + ' ' + msg;
    el.style.color = color || '#4ade80';
    el.style.borderColor = color || '#16a34a';
    el.style.opacity = '1';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      el.style.color = '#555';
      el.style.borderColor = '#333';
      el.style.background = '#111';
    }, 8000);
  }

  // ---- auto-snapshot -------------------------------------------------------
  let debounceTimer = null;
  let lastFingerprint = '';

  function onChange() {
    if (isStreaming()) return;
    const r = extractConversation();
    if (!r.messages.length) return;
    const fp = getFingerprint(r.messages);
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    send(r.messages, false);
  }

  function init() {
    buildUI();
    showStatus('pripojen', '#4ade80');

    const obs = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(onChange, DEBOUNCE_MS);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
      if (!document.getElementById('lg13-gem-shadow-host')) {
        shadow = null;
        buildUI();
        showStatus('obnoveno', '#4ade80');
      }
    }, 3000);

    log('LG13-GEM v' + VERSION + ' running (dom-only: user-query + model-response)');
  }

  init();

})();
