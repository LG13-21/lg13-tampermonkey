// ==UserScript==
// @name         ChatGPT -> LG13 Ingest (v5.1 + LG13_META v3.0 JSON footer)
// @namespace    lg13.local
// @version      5.1
// @description  v4.8 + LG13_META v3.0: JSON code block format {"LG13_META":{...}} alongside legacy <<LG13_META>> key:value
// @author       Tom / LG13
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      chatgpt.com
// @connect      chat.openai.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_ingest.user_JSON_v4.7.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_ingest.user_JSON_v4.7.js
// ==/UserScript==

// CHANGES vs v4.8 (LG13 footer v3.0):
//   - NEW: LG13_META v3.0 format — JSON fenced code block: ```json\n{"LG13_META":{...}}\n```
//     Both old <<LG13_META>> key:value AND new JSON block are supported simultaneously.
//   - extractLg13Meta() tries JSON block first, falls back to legacy key:value parser
//   - stripLg13Trailer() strips both formats
//   - schema bumped to lg13.v4.9

(function () {
  'use strict';

  if (window.__LG13_RUNNING__) return;
  window.__LG13_RUNNING__ = true;

  var GLYPH_HEX = String.fromCodePoint(0x2B21);
  var GLYPH_OK  = String.fromCodePoint(0x2713);
  var GLYPH_WRN = String.fromCodePoint(0x26A0);
  var GLYPH_HRG = String.fromCodePoint(0x23F3);

  const LG13_URL = 'http://127.0.0.1:8790/pl/chatgpt/ingest';
  const API_BASE = location.origin + '/backend-api/conversation/';
  const DEBOUNCE_MS = 2000;
  const SCHEMA_VERSION = 'lg13.v4.9';
  const API_CACHE_TTL_MS = 60 * 1000;

  const log = (...a) => console.log('[LG13]', ...a);
  const err = (...a) => console.error('[LG13-ERR]', ...a);

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function getConvId() {
    const m = location.href.match(/\/c\/([a-f0-9-]{36})/);
    if (m) return m[1];
    const seed = (document.title || '') +
      (document.body.innerText.slice(0, 500) || '');
    return 'fallback_' + hashStr(seed);
  }

  function getConvTitle() {
    const t = document.title || '';
    return t === 'ChatGPT' ? '' : t;
  }

  // ---- LG13_META trailer + [[ATOM]] split ----------------------------------
  // Trailer lives between <<LG13_META>> and <</LG13_META>>. Per protocol it is
  // wrapped in an HTML comment so voice/TTS skips it; parser accepts both.

  // Adaptive protocol (v1 adaptive): supports both full keys and short aliases.
  // Short keys: th=thread, tp=topic, tg=tags, rf=refs, ab=atom_break, fu=followup, ts=ts.
  // DELTA mode trailers may include only a subset; missing keys are fine downstream.
  const LG13_KEY_ALIAS = {
    th: 'thread',     tp: 'topic',        tg: 'tags',
    rf: 'refs',       ab: 'atom_break',   fu: 'followup',
    // protocol v2 extension (legal/emotional layering):
    ly: 'layer',      li: 'legal_intent', ah: 'atom_hint',
    st: 'story_id',   rk: 'risk'
  };

  function extractLg13Meta(rawText) {
    if (!rawText) return null;

    // --- v3.0 JSON block format: ```json\n{"LG13_META":{...}}\n``` ---
    const jsonBlockMatch = rawText.match(/```json\s*\n\s*(\{[\s\S]*?"LG13_META"[\s\S]*?\})\s*\n\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        const inner = parsed['LG13_META'] || parsed['lg13_meta'];
        if (inner && typeof inner === 'object') {
          // normalize short aliases
          const normalized = {};
          Object.entries(inner).forEach(([k, v]) => {
            const realKey = LG13_KEY_ALIAS[k] || k;
            if (v !== '' && v !== null && v !== undefined) normalized[realKey] = v;
          });
          return Object.keys(normalized).length ? normalized : null;
        }
      } catch (_) { /* fall through to legacy */ }
    }

    // --- legacy key:value format: <<LG13_META>>...<</LG13_META>> ---
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
          const arr = inner.split(',')
            .map(s => s.trim().replace(/^["']|["']$/g, ''))
            .filter(s => s.length);
          meta[realKey] = arr;
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
    // 1. v3.0 JSON block: ```json\n{"LG13_META":{...}}\n```
    let t = text.replace(
      /\n?```json\s*\n\s*\{[\s\S]*?"LG13_META"[\s\S]*?\}\s*\n\s*```\s*$/,
      ''
    );
    // 2. fenced code block wrap (```...```) — protocol v2 default with <<LG13_META>>
    t = t.replace(
      /(?:\n?---\s*\n)?```[a-z]*\s*\n[\s\S]*?<<LG13_META>>[\s\S]*?<<\/LG13_META>>[\s\S]*?```\s*$/,
      ''
    );
    // 3. HTML comment wrap (voice/TTS skip)
    t = t.replace(
      /(?:\n?---\s*\n)?<!--\s*[\s\S]*?<<LG13_META>>[\s\S]*?<<\/LG13_META>>[\s\S]*?-->\s*$/,
      ''
    );
    // 4. bare trailer (no wrap)
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

  // ---- API content text extractor (no length limit) -----------------------
  function _apiContentText(content) {
    if (!content) return null;
    const parts = content.parts;
    if (!Array.isArray(parts)) return null;
    const text = parts.filter(p => typeof p === 'string').join('\n').trim();
    return text || null;
  }

  // ---- ChatGPT backend API fetch -------------------------------------------
  const apiCache = new Map();

  async function fetchConvMeta(convId) {
    if (!convId || convId.startsWith('fallback_')) return null;
    const cached = apiCache.get(convId);
    if (cached && (Date.now() - cached.ts) < API_CACHE_TTL_MS) return cached.data;

    try {
      const resp = await fetch(API_BASE + convId, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) {
        err('api', resp.status, convId);
        return null;
      }
      const j = await resp.json();
      const byMsg = {};
      const mapping = j && j.mapping ? j.mapping : {};
      for (const nodeId of Object.keys(mapping)) {
        const node = mapping[nodeId];
        const msg = node && node.message;
        if (!msg) continue;
        const ct = (typeof msg.create_time === 'number') ? msg.create_time : null;
        const ut = (typeof msg.update_time === 'number') ? msg.update_time : null;
        const md = msg.metadata || {};
        byMsg[msg.id || nodeId] = {
          ts: ct ? new Date(ct * 1000).toISOString() : null,
          update_ts: ut ? new Date(ut * 1000).toISOString() : null,
          model_slug: md.model_slug || msg.metadata && msg.metadata.default_model_slug || null,
          parent: node.parent || null,
          children: node.children || [],
          role: msg.author && msg.author.role || null,
          content_text: _apiContentText(msg.content),
        };
      }
      const data = {
        meta: {
          title: j.title || null,
          create_time: j.create_time ? new Date(j.create_time * 1000).toISOString() : null,
          update_time: j.update_time ? new Date(j.update_time * 1000).toISOString() : null,
          model_slug: j.model_slug || null,
          current_node: j.current_node || null,
        },
        byMsg,
      };
      apiCache.set(convId, { ts: Date.now(), data });
      return data;
    } catch (e) {
      err('api fetch failed', e);
      return null;
    }
  }

  // ---- DOM-based timestamps (fallback) -------------------------------------
  const TS_PATTERNS = [
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/,
    /\b(\d{1,2}[.:]\d{2}(?::\d{2})?)\b/
  ];

  function extractTurnTimestamp(el) {
    const timeEl = el.querySelector('time[datetime]');
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime');
      if (dt) {
        const parsed = new Date(dt);
        if (!isNaN(parsed.getTime())) {
          return { ts: parsed.toISOString(), ts_source: 'dom' };
        }
      }
    }
    const ariaCandidates = [];
    if (el.hasAttribute('aria-label')) ariaCandidates.push(el.getAttribute('aria-label'));
    el.querySelectorAll('[aria-label], [title]').forEach(n => {
      const al = n.getAttribute('aria-label');
      const tt = n.getAttribute('title');
      if (al) ariaCandidates.push(al);
      if (tt) ariaCandidates.push(tt);
    });
    for (const label of ariaCandidates) {
      for (const pat of TS_PATTERNS) {
        const m = label.match(pat);
        if (m) {
          if (m[1].includes('T')) {
            const parsed = new Date(m[1]);
            if (!isNaN(parsed.getTime())) {
              return { ts: parsed.toISOString(), ts_source: 'aria' };
            }
          }
          const today = new Date();
          const [hh, mm, ss] = m[1].split(/[.:]/).map(Number);
          today.setHours(hh || 0, mm || 0, ss || 0, 0);
          return { ts: today.toISOString(), ts_source: 'aria' };
        }
      }
    }
    return { ts: new Date().toISOString(), ts_source: 'capture' };
  }

  // ---- images --------------------------------------------------------------
  function extractImages(el) {
    const imgs = el.querySelectorAll('img');
    const out = [];
    let n = 0;
    imgs.forEach(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const cls = (img.className || '').toString().toLowerCase();
      if (w > 0 && w < 32 && h > 0 && h < 32) return;
      if (/avatar|icon|emoji/.test(cls)) return;
      const token = '[[IMG:' + n + ']]';
      out.push({
        token: token, idx: n,
        src: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || '',
        w: w || null, h: h || null
      });
      const marker = document.createTextNode(' ' + token + ' ');
      img.parentNode.insertBefore(marker, img);
      n++;
    });
    return out;
  }

  function extractText(el) {
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

  async function extractConversation() {
    const turns = document.querySelectorAll('[data-message-author-role]');
    if (!turns.length) return { messages: [], apiMeta: null };
    const convId = getConvId();
    const api = await fetchConvMeta(convId);
    const byMsg = api ? api.byMsg : null;

    const messages = [];
    let idx = 0;

    turns.forEach(el => {
      const role = el.getAttribute('data-message-author-role');
      const msgId = el.getAttribute('data-message-id') || null;
      const images = extractImages(el);
      const domText = extractText(el);
      // v4.8: prefer API content_text when longer (fixes ChatGPT DOM truncation of long messages)
      const apiHitEarly = byMsg && msgId ? byMsg[msgId] : null;
      const apiContent = apiHitEarly && apiHitEarly.content_text ? apiHitEarly.content_text : null;
      const rawText = (apiContent && apiContent.length > domText.length) ? apiContent : domText;
      if ((!rawText || rawText.length < 5) && images.length === 0) return;

      // v4.7: parse trailer + atoms BEFORE stripping
      const lg13_meta = extractLg13Meta(rawText);
      const cleanText = stripLg13Trailer(rawText);
      const lg13_atoms = splitLg13Atoms(cleanText);

      const imageTokens = images.map(i => i.token).join('|');
      const id = hashStr(role + '|' + cleanText + '|' + imageTokens);

      let ts, ts_source, model_slug = null, parent = null, update_ts = null;
      const apiHit = apiHitEarly;
      if (apiHit && apiHit.ts) {
        ts = apiHit.ts;
        ts_source = 'api';
        model_slug = apiHit.model_slug || null;
        parent = apiHit.parent || null;
        update_ts = apiHit.update_ts || null;
      } else {
        const dom = extractTurnTimestamp(el);
        ts = dom.ts;
        ts_source = dom.ts_source;
      }

      messages.push({
        id: id, idx: idx,
        msg_id: msgId,
        role: role === 'user' ? 'user' : 'assistant',
        text: cleanText,
        lg13_meta: lg13_meta,
        lg13_atoms: lg13_atoms,
        ts: ts, ts_source: ts_source,
        update_ts: update_ts,
        model_slug: model_slug,
        parent: parent,
        images: images
      });
      idx++;
    });

    return { messages: messages, apiMeta: api ? api.meta : null };
  }

  function getFingerprint(messages) {
    return hashStr(messages.map(m => m.id).join('|'));
  }

  // ---- send + toast --------------------------------------------------------
  function send(messages, apiMeta, manual) {
    if (!messages || !messages.length) {
      if (manual) showStatus('nic k odeslani', '#fb923c');
      return;
    }
    const meta = {
      schema: SCHEMA_VERSION,
      conv_id: getConvId(),
      title: getConvTitle(),
      url: location.href,
      captured_at: new Date().toISOString(),
      fingerprint: getFingerprint(messages),
      api: apiMeta || null
    };
    const payload = JSON.stringify({ meta: meta, messages: messages });
    showStatus(GLYPH_HRG + ' odesilam...', '#4ade80');
    const imgCount  = messages.reduce((s, m) => s + (m.images ? m.images.length : 0), 0);
    const apiCount  = messages.reduce((s, m) => s + (m.ts_source === 'api' ? 1 : 0), 0);
    const metaCount = messages.reduce((s, m) => s + (m.lg13_meta ? 1 : 0), 0);

    function onSuccess(responseText) {
      log('sent', messages.length, 'imgs:', imgCount, 'api-ts:', apiCount, 'meta:', metaCount);
      let n = '';
      try {
        const d = JSON.parse(responseText);
        if (d && d.atoms_count != null) n = ' / ' + d.atoms_count + ' atoms';
        else if (d && Array.isArray(d.atom_ids)) n = ' / ' + d.atom_ids.length + ' atoms';
      } catch (_) {}
      const tail = (imgCount  ? ' (' + imgCount + ' img)' : '') +
                   (apiCount  ? ' [api:' + apiCount + ']' : '') +
                   (metaCount ? ' [meta:' + metaCount + ']' : '');
      showStatus(GLYPH_OK + ' ' + messages.length + ' msgs' + n + tail, '#4ade80');
    }

    function sendViaFetch() {
      fetch(LG13_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }).then(r => r.text()).then(onSuccess).catch(e => {
        err('fetch fallback failed', e);
        showStatus(GLYPH_WRN + ' err(fetch)', '#f87171');
      });
    }

    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: LG13_URL,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        timeout: 20000,
        onload: (resp) => onSuccess(resp.responseText),
        onerror: (e) => { err('GM err, trying fetch', e); sendViaFetch(); },
        ontimeout: () => { err('GM timeout, trying fetch'); sendViaFetch(); }
      });
    } catch (e) {
      err('GM_xmlhttpRequest threw, trying fetch', e);
      sendViaFetch();
    }
  }

  function isStreaming() {
    return !!document.querySelector('[data-testid="stop-button"]');
  }

  // ---- shadow-DOM toast UI -------------------------------------------------
  let shadow = null;
  let statusTimer = null;
  function buildUI() {
    if (shadow) return;
    const host = document.createElement('div');
    host.id = 'lg13-shadow-host';
    Object.assign(host.style, {
      position: 'fixed', bottom: '0', right: '0', width: '0', height: '0',
      zIndex: '2147483647', pointerEvents: 'none', overflow: 'visible'
    });
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '#btn { position: fixed; bottom: 60px; right: 16px; z-index: 2147483647;',
      '       background: #07101e; border: 1px solid #1e3358; color: #4b8ef5;',
      '       padding: 5px 10px; border-radius: 6px; font-size: 11px;',
      '       cursor: pointer; font-family: monospace; font-weight: 600;',
      '       box-shadow: 0 2px 8px rgba(0,0,0,.6); pointer-events: auto;',
      '       user-select: none; }',
      '#btn:hover { background: #0d1f3c; border-color: #4b8ef5; }',
      '#status { position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;',
      '          padding: 5px 10px; border-radius: 6px; font-size: 11px;',
      '          font-family: monospace; font-weight: 600;',
      '          background: #052e16; border: 1px solid #16a34a; color: #4ade80;',
      '          pointer-events: none; opacity: 0; transition: opacity 0.3s;',
      '          white-space: nowrap; }'
    ].join('\n');
    shadow.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'btn';
    btn.textContent = GLYPH_HEX + ' LG13 v4.7';
    btn.addEventListener('click', async () => {
      const r = await extractConversation();
      send(r.messages, r.apiMeta, true);
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
    el.textContent = GLYPH_HEX + ' LG13 v4.7 ' + msg;
    el.style.color = color || '#4ade80';
    el.style.borderColor = color || '#16a34a';
    el.style.opacity = '1';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  // ---- auto-snapshot -------------------------------------------------------
  let debounceTimer = null;
  let lastFingerprint = '';

  async function onChange() {
    if (isStreaming()) return;
    const r = await extractConversation();
    if (!r.messages.length) return;
    const fp = getFingerprint(r.messages);
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    send(r.messages, r.apiMeta, false);
  }

  function init() {
    buildUI();
    showStatus('pripojen', '#4ade80');

    const obs = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { onChange().catch(err); }, DEBOUNCE_MS);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // SPA navigation: reset fingerprint when URL changes (new conversation)
    let _lastUrl = location.href;
    const _origPush = history.pushState.bind(history);
    history.pushState = function(...args) {
      _origPush(...args);
      if (location.href !== _lastUrl) {
        _lastUrl = location.href;
        lastFingerprint = '';
        setTimeout(() => onChange().catch(err), 1500);
      }
    };
    window.addEventListener('popstate', () => {
      if (location.href !== _lastUrl) {
        _lastUrl = location.href;
        lastFingerprint = '';
        setTimeout(() => onChange().catch(err), 1500);
      }
    });

    setInterval(() => {
      if (!document.getElementById('lg13-shadow-host')) {
        shadow = null;
        buildUI();
        showStatus('obnoveno', '#4ade80');
      }
    }, 3000);

    log('LG13 v4.7 running (api ts + images + meta + atoms)');
  }

  init();

})();
