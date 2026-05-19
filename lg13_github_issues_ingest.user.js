// ==UserScript==
// @name         GitHub Issues -> LG13 Ingest
// @namespace    lg13.local
// @version      1.0
// @description  Ingests GitHub issue body + comments into LG13 atom pipeline on page load / new comment
// @author       Tom / LG13 / coder
// @match        https://github.com/*/*/issues/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_github_issues_ingest.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_github_issues_ingest.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__LG13_GH_RUNNING__) return;
  window.__LG13_GH_RUNNING__ = true;

  const LG13_URL = 'http://127.0.0.1:8790/pl/chatgpt/ingest';
  const SCHEMA   = 'lg13.v4.7';
  const DEBOUNCE = 3000;

  const log = (...a) => console.log('[LG13-GH]', ...a);
  const err = (...a) => console.error('[LG13-GH-ERR]', ...a);

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  // Parse repo + issue number from URL
  function getIssueInfo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], number: parseInt(m[3]), url: location.href };
  }

  // Extract issue body from DOM
  function getIssueBody() {
    const el = document.querySelector('.js-comment-container .comment-body, [data-testid="issue-body"] .markdown-body');
    return el ? el.innerText.trim() : '';
  }

  // Extract all comments from DOM
  function getComments() {
    const items = [];
    document.querySelectorAll('.timeline-comment, .js-comment').forEach(el => {
      const authorEl = el.querySelector('.author, [data-hovercard-type="user"]');
      const bodyEl   = el.querySelector('.comment-body, .markdown-body');
      const timeEl   = el.querySelector('relative-time, time');
      if (!bodyEl) return;
      const text = bodyEl.innerText.trim();
      if (!text) return;
      items.push({
        author:    authorEl ? authorEl.textContent.trim() : 'unknown',
        body:      text,
        ts:        timeEl ? (timeEl.getAttribute('datetime') || timeEl.title || '') : '',
        id:        el.id || hashStr(text.slice(0, 100))
      });
    });
    return items;
  }

  // Extract <<LG13_META>> trailer if present in comment
  function extractMeta(text) {
    const m = text.match(/<<LG13_META>>([\s\S]*?)<<\/LG13_META>>/);
    if (!m) return null;
    const meta = {};
    m[1].split('\n').forEach(line => {
      const mm = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
      if (!mm || !mm[2]) return;
      let v = mm[2].replace(/^["']|["']$/g, '');
      if (v === 'true')  { meta[mm[1]] = true;  return; }
      if (v === 'false') { meta[mm[1]] = false; return; }
      if (/^-?\d+$/.test(v)) { meta[mm[1]] = parseInt(v); return; }
      meta[mm[1]] = v;
    });
    return Object.keys(meta).length ? meta : null;
  }

  function stripMeta(text) {
    return text.replace(/<<LG13_META>>[\s\S]*?<<\/LG13_META>>/g, '').trim();
  }

  // Build atom messages array
  function buildMessages(info, body, comments) {
    const msgs = [];

    // Issue body as first "message"
    if (body) {
      msgs.push({
        role:       'issue_body',
        author:     info.owner,
        text:       stripMeta(body),
        lg13_meta:  extractMeta(body),
        ts:         new Date().toISOString(),
        id:         hashStr(`body:${body.slice(0, 200)}`)
      });
    }

    // Each comment
    comments.forEach((c, i) => {
      msgs.push({
        role:       'comment',
        author:     c.author,
        text:       stripMeta(c.body),
        lg13_meta:  extractMeta(c.body),
        ts:         c.ts,
        id:         hashStr(`comment:${c.id}:${c.body.slice(0, 100)}`)
      });
    });

    return msgs;
  }

  // Ingest to pl_server
  function ingest(force) {
    const info = getIssueInfo();
    if (!info) return;

    // Only ingest configured repos unless forced
    const WATCH_REPOS = ['LG13-21/legal-ship-2026'];
    const repoFull = `${info.owner}/${info.repo}`;
    if (!force && !WATCH_REPOS.includes(repoFull)) {
      log(`Skipping non-watched repo: ${repoFull}`);
      return;
    }

    const body     = getIssueBody();
    const comments = getComments();
    const messages = buildMessages(info, body, comments);

    if (!messages.length) { log('No content found'); return; }

    // Dedup key: hash of last comment text
    const lastMsg  = messages[messages.length - 1];
    const dedup_id = `gh_issue_${info.number}_${lastMsg.id}`;
    const sessionKey = `lg13_gh_ingest_${dedup_id}`;
    if (!force && sessionStorage.getItem(sessionKey)) {
      log(`Already ingested (${dedup_id}), skipping`);
      return;
    }
    sessionStorage.setItem(sessionKey, '1');

    const title = document.querySelector('h1.gh-header-title, .js-issue-title, h1 bdi')?.textContent?.trim()
                  || `Issue #${info.number}`;

    const payload = {
      schema:       SCHEMA,
      source:       'github_issue',
      conv_id:      `gh_${info.owner}_${info.repo}_issue_${info.number}`,
      title:        `[GH #${info.number}] ${title}`,
      repo:         repoFull,
      issue_number: info.number,
      issue_url:    info.url,
      messages,
      ts:           new Date().toISOString()
    };

    log(`Ingesting issue #${info.number} (${messages.length} items)...`);

    GM_xmlhttpRequest({
      method:  'POST',
      url:     LG13_URL,
      headers: { 'Content-Type': 'application/json' },
      data:    JSON.stringify(payload),
      onload:  r => {
        try {
          const resp = JSON.parse(r.responseText);
          if (resp.ok !== false) log(`✓ Ingested ${messages.length} items, issue #${info.number}`);
          else err('Server error:', resp.error);
        } catch(e) {
          log('Ingest response:', r.status, r.responseText.slice(0, 100));
        }
      },
      onerror: e => err('Network error:', e)
    });
  }

  // Badge overlay
  function showBadge(text, ok) {
    let b = document.getElementById('lg13-gh-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'lg13-gh-badge';
      Object.assign(b.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: 9999,
        background: '#161b22', border: '1px solid #30363d', borderRadius: '6px',
        padding: '6px 12px', fontSize: '12px', fontFamily: 'monospace',
        color: ok ? '#3fb950' : '#f0883e', cursor: 'pointer'
      });
      b.onclick = () => ingest(true);
      document.body.appendChild(b);
    }
    b.textContent = `⬡ LG13 ${text}`;
    setTimeout(() => { if (b) b.style.color = '#8b949e'; }, 3000);
  }

  // MutationObserver — watch for new comments
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      log('DOM change detected — re-ingesting');
      ingest(false);
      showBadge('ingested', true);
    }, DEBOUNCE);
  });

  // Initial ingest
  setTimeout(() => {
    ingest(false);
    showBadge('ingested', true);

    // Watch timeline for new comments
    const timeline = document.querySelector('.js-discussion, .js-timeline-container, #discussion_bucket');
    if (timeline) {
      observer.observe(timeline, { childList: true, subtree: true });
      log('Observer armed on timeline');
    } else {
      log('Timeline not found — observer not armed');
    }
  }, 2000);

  log('GitHub Issues Ingest v1.0 loaded');
})();
