// ==UserScript==
// @name         Suno → LG13 Catalog
// @namespace    lg13.local
// @version      6.7
// @description  Captures Suno playlist + auto-fetches full details (lyrics, tags, plays, likes) by visiting each /song/ page in background. [v6.7: pl_server proxy]
// @author       Tom / LG13
// @match        https://suno.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    http://127.0.0.1:8790/pl/tmonkey/lg13_suno_catalog.user.js
// @downloadURL  http://127.0.0.1:8790/pl/tmonkey/lg13_suno_catalog.user.js
// ==/UserScript==

(function() {
  'use strict';

  const LG13_INGEST    = 'http://127.0.0.1:8790/pl/chatgpt/ingest';
  const FETCH_DELAY_MS = 300;     // delay between /song/ fetches
  const FETCH_PARALLEL = 3;       // concurrent fetches
  const STORAGE_KEY    = 'lg13_suno_catalog_v1';

  const songs = new Map();        // id -> song object (persisted)
  let playlistName = '';
  let isFetching = false;
  let refetchAll = false;         // if true, refetch even already-known songs

  // ── Persistence ──────────────────────────────────────────────────────────
  function loadCatalog() {
    try {
      const raw = GM_getValue(STORAGE_KEY, '{}');
      const obj = JSON.parse(raw);
      for (const id in obj) songs.set(id, obj[id]);
    } catch (e) { console.warn('[LG13-SUNO] load err', e); }
  }
  function saveCatalog() {
    try {
      const obj = {};
      for (const [id, s] of songs) obj[id] = s;
      GM_setValue(STORAGE_KEY, JSON.stringify(obj));
    } catch (e) { console.warn('[LG13-SUNO] save err', e); }
  }
  function clearCatalog() {
    songs.clear();
    GM_setValue(STORAGE_KEY, '{}');
    updateBtnCount();
    showStatus('katalog vymazan', '#fb923c');
  }

  // ── Collect song IDs from current playlist page ───────────────────────────
  function collectIds() {
    const ids = new Set();
    // Prefer main playlist container, exclude player bar at bottom
    const main = document.querySelector('main') || document.body;
    main.querySelectorAll('a[href*="/song/"]').forEach(a => {
      // Skip if inside the player bar (footer/bottom controls)
      if (a.closest('[class*="player"], [class*="Player"], footer, [role="contentinfo"]')) return;
      const m = a.href.match(/\/song\/([a-f0-9-]{36})/);
      if (m) ids.add(m[1]);
    });
    return Array.from(ids);
  }

  // ── Auto-scroll to load all songs in playlist ─────────────────────────────
  async function scrollPlaylist() {
    showStatus('scrolluju playlist...', '#fbbf24');
    let lastCount = 0;
    let stableRounds = 0;
    while (stableRounds < 3) {
      const scrollable = findScrollable();
      if (!scrollable) break;
      scrollable.scrollBy(0, 800);
      await sleep(400);
      const ids = collectIds();
      if (ids.length === lastCount) stableRounds++;
      else { stableRounds = 0; lastCount = ids.length; }
      showStatus(`scroll: ${ids.length} ID nalezeno`, '#fbbf24');
    }
    return collectIds();
  }

  function findScrollable() {
    for (const el of [
      document.querySelector('main'),
      document.querySelector('[class*="scroll"]'),
      document.documentElement,
    ]) {
      if (el && el.scrollHeight > el.clientHeight + 50) return el;
    }
    return null;
  }

  // ── Parse playlist name from page ─────────────────────────────────────────
  function getPlaylistName() {
    if (playlistName) return playlistName;
    const h = document.querySelector('h1');
    if (h) playlistName = h.textContent.trim();
    if (!playlistName) playlistName = document.title.replace(' | Suno', '').trim();
    return playlistName;
  }

  // ── Fetch /song/{id} HTML and parse RSC data ──────────────────────────────
  function fetchSongHtml(id) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://suno.com/song/${id}`,
        timeout: 15000,
        onload(resp) {
          try {
            const song = parseRSCFromHtml(resp.responseText, id);
            if (song) {
              song._captured_at = new Date().toISOString();
              song._playlists = song._playlists || [];
              const plName = getPlaylistName();
              if (plName && !song._playlists.includes(plName)) {
                song._playlists.push(plName);
              }
              // Merge with existing if any (preserve _playlists from prior)
              const existing = songs.get(id);
              if (existing && existing._playlists) {
                for (const p of existing._playlists) {
                  if (!song._playlists.includes(p)) song._playlists.push(p);
                }
              }
              songs.set(id, song);
            }
          } catch (e) {
            console.error('[LG13-SUNO] parse err for', id, e);
          }
          resolve();
        },
        onerror() { resolve(); },
        ontimeout() { resolve(); },
      });
    });
  }

  // ── Parse RSC content from /song/{id} HTML ────────────────────────────────
  function parseRSCFromHtml(html, id) {
    // Collect all __next_f.push pushes in order
    const pushRegex = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]/g;
    let match;
    const allPushes = [];
    while ((match = pushRegex.exec(html)) !== null) {
      let content;
      try { content = JSON.parse('"' + match[1] + '"'); }
      catch { content = match[1]; }
      allPushes.push(content);
    }

    // Build chunk map. RSC pattern:
    //   Header push:  "NN:T<hex>," (text chunk header — body comes in NEXT push)
    //   Inline:       "NN:[..." or "NN:{..." (data follows directly)
    const chunkMap = {};
    for (let i = 0; i < allPushes.length; i++) {
      const c = allPushes[i];
      // Text chunk header: "NN:T<hex>," and content is empty after comma
      const textHeader = c.match(/^([a-f0-9]+):T[a-f0-9]+,$/);
      if (textHeader && i + 1 < allPushes.length) {
        // Next push contains the actual text content
        chunkMap[textHeader[1]] = allPushes[i + 1];
        i++; // skip the body push
        continue;
      }
      // Inline chunk: "NN:..."
      const inline = c.match(/^([a-f0-9]+):([\s\S]*)$/);
      if (inline) {
        chunkMap[inline[1]] = inline[2];
      }
    }

    const fullText = allPushes.join('\n');
    if (!fullText.includes(`"id":"${id}"`)) return null;

    return extractSongFields(fullText, id, chunkMap);
  }

  function extractSongFields(text, id, chunkMap) {
    // Find clip object around our id — songs in playlist responses contain
    // {"clip":{"status":"complete","title":"...","id":"<id>",...,"metadata":{...}}}
    // We want to slice from the start of THIS clip's object to its end.
    const idIdx = text.indexOf(`"id":"${id}"`);
    if (idIdx < 0) return null;

    // Walk backward to find the opening {"clip":{ or {"status": (clip start)
    let start = idIdx;
    for (let i = idIdx; i > Math.max(0, idIdx - 5000); i--) {
      // Heuristic: clip object usually starts with {"status":"complete" or similar
      if (text.slice(i, i + 18) === '{"status":"complete' ||
          text.slice(i, i + 8) === '{"clip":' ||
          text.slice(i, i + 12) === '{"metadata":') {
        start = i;
        break;
      }
    }
    // Take a generous window — clips with full metadata can be ~5KB
    const slice = text.slice(start, idIdx + 8000);

    function get(re) {
      const m = slice.match(re);
      return m ? m[1] : '';
    }
    function getNum(re) {
      const m = slice.match(re);
      return m ? parseFloat(m[1]) : 0;
    }
    // Unescape one level of JSON-string escaping
    function unesc(s) {
      try { return JSON.parse('"' + s + '"'); } catch { return s; }
    }
    // Resolve $XX references (hex chunk IDs) recursively
    function resolveRef(val) {
      if (!val) return val;
      const refMatch = String(val).match(/^\$([a-f0-9]+)$/);
      if (refMatch && chunkMap[refMatch[1]]) {
        let resolved = chunkMap[refMatch[1]];
        // Chunk content may itself be a quoted string
        if (resolved.startsWith('"') && resolved.endsWith('"')) {
          try { resolved = JSON.parse(resolved); } catch {}
        }
        return resolved;
      }
      return val;
    }

    const title       = get(/"title":"((?:\\.|[^"\\])*)"/);
    const tags        = get(/"tags":"((?:\\.|[^"\\])*)"/);
    const promptRaw   = get(/"prompt":"((?:\\.|[^"\\])*)"/);
    const gptDesc     = get(/"gpt_description_prompt":"((?:\\.|[^"\\])*)"/);
    const duration    = getNum(/"duration":([\d.]+)/);
    const playCount   = getNum(/"play_count":(\d+)/);
    const upvotes     = getNum(/"upvote_count":(\d+)/);
    const comments    = getNum(/"num_comments":(\d+)/) || getNum(/"comment_count":(\d+)/);
    const audioUrl    = get(/"audio_url":"((?:\\.|[^"\\])*)"/);
    const videoUrl    = get(/"video_url":"((?:\\.|[^"\\])*)"/);
    const imageUrl    = get(/"image_url":"((?:\\.|[^"\\])*)"/);
    const createdAt   = get(/"created_at":"([^"]*)"/);
    const status      = get(/"status":"([^"]*)"/);
    const isPublic    = slice.includes('"is_public":true');
    const handle      = get(/"handle":"((?:\\.|[^"\\])*)"/);
    const userId      = get(/"user_id":"([a-f0-9-]+)"/);
    const majorModel  = get(/"major_model_version":"([^"]*)"/);

    // Resolve lyrics: may be inline OR a $XX reference
    let lyrics = unesc(promptRaw);
    if (lyrics && lyrics.startsWith('$')) {
      const resolved = resolveRef(promptRaw);
      lyrics = unesc(resolved);
    }

    return {
      id,
      title: unesc(title) || '(bez nazvu)',
      account: unesc(handle),
      account_id: userId,
      lyrics: lyrics || '',
      prompt_style: unesc(tags),
      style: majorModel,
      description: unesc(gptDesc),
      duration,
      play_count: playCount,
      upvote_count: upvotes,
      comment_count: comments,
      created_at: createdAt,
      is_public: isPublic,
      status,
      clip_url: `https://suno.com/song/${id}`,
      audio_url: unesc(audioUrl),
      image_url: unesc(imageUrl),
      video_url: unesc(videoUrl),
    };
  }

  // ── Main flow: scroll → collect IDs → fetch new/missing → merge into catalog
  async function captureAll() {
    if (isFetching) return;
    isFetching = true;

    const ids = await scrollPlaylist();
    if (ids.length === 0) {
      showStatus('zadne songy nenalezeny', '#fb923c');
      isFetching = false;
      return;
    }

    // Update _playlists membership for ALL ids on this page (even already-known)
    const plName = getPlaylistName();
    if (plName) {
      for (const id of ids) {
        const s = songs.get(id);
        if (s) {
          s._playlists = s._playlists || [];
          if (!s._playlists.includes(plName)) s._playlists.push(plName);
        }
      }
    }

    // Filter: only fetch new ones (or all if refetchAll mode)
    const todo = refetchAll ? ids : ids.filter(id => !songs.has(id));
    const skipped = ids.length - todo.length;

    if (todo.length === 0) {
      showStatus(`vse uz mame: ${ids.length} songu v katalogu`, '#4ade80');
      isFetching = false;
      // Still update _playlists membership for existing
      const plName = getPlaylistName();
      for (const id of ids) {
        const s = songs.get(id);
        if (s && plName) {
          s._playlists = s._playlists || [];
          if (!s._playlists.includes(plName)) s._playlists.push(plName);
        }
      }
      saveCatalog();
      sendToLG13();
      return;
    }

    showStatus(`stahuju ${todo.length} novych (${skipped} jiz v katalogu)...`, '#93c5fd');

    let done = 0;
    const queue = [...todo];

    async function worker() {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        await fetchSongHtml(id);
        done++;
        if (done % 5 === 0 || done === ids.length) {
          showStatus(`detaily: ${done}/${ids.length}`, '#93c5fd');
          updateBtnCount();
        }
        await sleep(FETCH_DELAY_MS);
      }
    }

    const workers = [];
    for (let i = 0; i < FETCH_PARALLEL; i++) workers.push(worker());
    await Promise.all(workers);

    isFetching = false;
    saveCatalog();
    showStatus(`hotovo: +${done} novych, celkem ${songs.size}`, '#4ade80');
    updateBtnCount();
    sendToLG13();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Format and send to LG13 ───────────────────────────────────────────────
  function formatCatalog() {
    const all = Array.from(songs.values());
    if (all.length === 0) return null;

    const name = getPlaylistName();
    const lines = [];
    lines.push(`SUNO PLAYLIST: ${name}`);
    lines.push(`URL: ${location.href}`);
    lines.push(`Datum exportu: ${new Date().toISOString()}`);
    lines.push(`Pocet skladeb: ${all.length}`);
    lines.push('');
    lines.push('---');

    all.forEach((s, i) => {
      lines.push('');
      lines.push(`=== [${i + 1}] ${s.title} ===`);
      lines.push(`ID: ${s.id}`);
      lines.push(`Odkaz: ${s.clip_url}`);
      if (s._playlists && s._playlists.length > 0) {
        lines.push(`Playlists: ${s._playlists.join(' | ')}`);
      }
      if (s.account)      lines.push(`Account: ${s.account}`);
      if (s.account_id)   lines.push(`Account ID: ${s.account_id}`);
      if (s.prompt_style) lines.push(`Prompt style (tags): ${s.prompt_style}`);
      if (s.style)        lines.push(`Style/model: ${s.style}`);
      if (s.description)  lines.push(`Description: ${s.description}`);
      if (s.duration > 0) {
        const total = Math.round(s.duration);
        const m = Math.floor(total / 60);
        const sec = total % 60;
        lines.push(`Length: ${m}:${String(sec).padStart(2, '0')} (${total}s)`);
      }
      if (s.play_count > 0)    lines.push(`Plays: ${s.play_count}`);
      if (s.upvote_count > 0)  lines.push(`Likes: ${s.upvote_count}`);
      if (s.comment_count > 0) lines.push(`Comments: ${s.comment_count}`);
      lines.push(`Public: ${s.is_public ? 'ano' : 'ne'}`);
      if (s.status)     lines.push(`Status: ${s.status}`);
      if (s.created_at) lines.push(`Created: ${s.created_at}`);
      if (s.audio_url)  lines.push(`Audio URL: ${s.audio_url}`);
      if (s.image_url)  lines.push(`Image URL: ${s.image_url}`);
      if (s.video_url)  lines.push(`Video URL: ${s.video_url}`);
      if (s.lyrics) {
        lines.push(`Lyrics:`);
        lines.push(s.lyrics);
      }
    });

    return { text: lines.join('\n'), name, count: all.length };
  }

  function sendToLG13() {
    const catalog = formatCatalog();
    if (!catalog) {
      showStatus('zadne songy', '#fb923c');
      return;
    }
    const safe = catalog.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 50);
    const cleanText = catalog.text.replace(/[\uD800-\uDFFF]/g, '');
    const sizeKB = Math.round(cleanText.length / 1024);
    showStatus(`odesilam ${catalog.count} skladeb (${sizeKB}KB)...`, '#93c5fd');

    GM_xmlhttpRequest({
      method: 'POST',
      url: LG13_INGEST,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        text: cleanText,
        source: 'suno',
        url: location.href,
        ts: new Date().toISOString(),
        conv_id: `suno_${safe}`,
        conv_name: `suno_${safe}`,
        day_offset: 0,
      }),
      timeout: 60000,
      onload(resp) {
        try {
          const d = JSON.parse(resp.responseText);
          if (d.ok) showStatus(`OK ${catalog.count} skladeb (${d.bytes}B)`, '#4ade80');
          else showStatus(`err: ${resp.responseText.slice(0, 80)}`, '#fb923c');
        } catch {
          showStatus(`resp ${resp.status}`, '#fb923c');
        }
      },
      onerror() { showStatus('LG13 offline', '#f87171'); },
      ontimeout() { showStatus('timeout', '#f87171'); },
    });
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  let shadow = null;
  let statusTimer = null;

  function buildUI() {
    if (shadow) return;
    const host = document.createElement('div');
    host.id = 'lg13-suno-host';
    Object.assign(host.style, {
      position: 'fixed', bottom: '0', right: '0',
      width: '0', height: '0', zIndex: '2147483647',
      pointerEvents: 'none', overflow: 'visible',
    });
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .btn {
          position: fixed; right: 16px; z-index: 2147483647;
          border-radius: 6px; font-size: 11px;
          cursor: pointer; font-family: monospace; font-weight: 600;
          box-shadow: 0 2px 8px rgba(0,0,0,.6); pointer-events: auto;
          padding: 6px 12px; border: 1px solid;
        }
        #btn-capture {
          bottom: 210px;
          background: #0f172a; border-color: #7c3aed; color: #a78bfa;
        }
        #btn-capture:hover { background: #1e1b4b; border-color: #a78bfa; }
        #btn-refetch {
          bottom: 180px;
          background: #0f172a; border-color: #d97706; color: #fbbf24;
        }
        #btn-refetch:hover { background: #1c1001; border-color: #fbbf24; }
        #btn-send {
          bottom: 150px;
          background: #0f172a; border-color: #06b6d4; color: #67e8f9;
        }
        #btn-send:hover { background: #0c1929; border-color: #67e8f9; }
        #btn-clear {
          bottom: 120px;
          background: #0f172a; border-color: #dc2626; color: #f87171;
          font-size: 10px; padding: 4px 8px;
        }
        #btn-clear:hover { background: #1f0808; border-color: #f87171; }
        #status {
          position: fixed; bottom: 90px; right: 16px; z-index: 2147483647;
          padding: 6px 12px; border-radius: 6px; font-size: 11px;
          font-family: monospace; font-weight: 600;
          background: #1e1b4b; border: 1px solid #7c3aed; color: #a78bfa;
          pointer-events: none; opacity: 0; transition: opacity 0.3s;
          max-width: 280px;
        }
      </style>
      <button class="btn" id="btn-capture">CAPTURE NEW <span id="cnt"></span></button>
      <button class="btn" id="btn-refetch">refetch ALL</button>
      <button class="btn" id="btn-send">poslat do LG13</button>
      <button class="btn" id="btn-clear">vymazat katalog</button>
      <div id="status"></div>
    `;
    shadow.getElementById('btn-capture').addEventListener('click', () => { refetchAll = false; captureAll(); });
    shadow.getElementById('btn-refetch').addEventListener('click', () => {
      if (confirm('Refetchnout VSECHNY songy znovu (i ty co uz mas)? Trva dlouho.')) {
        refetchAll = true; captureAll();
      }
    });
    shadow.getElementById('btn-send').addEventListener('click', sendToLG13);
    shadow.getElementById('btn-clear').addEventListener('click', () => {
      if (confirm(`Smazat cely katalog (${songs.size} songu)? Nelze vratit.`)) clearCatalog();
    });
  }

  function updateBtnCount() {
    if (!shadow) return;
    const cnt = shadow.getElementById('cnt');
    if (cnt) cnt.textContent = songs.size > 0 ? `[${songs.size}]` : '';
  }

  function showStatus(msg, color = '#a78bfa') {
    if (!shadow) return;
    const el = shadow.getElementById('status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = color;
    el.style.borderColor = color;
    el.style.opacity = '1';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.style.opacity = '0'; }, 6000);
  }

  function init() {
    loadCatalog();
    buildUI();
    updateBtnCount();
    showStatus(`katalog: ${songs.size} songu`, '#a78bfa');
    setInterval(() => {
      if (!document.getElementById('lg13-suno-host')) {
        shadow = null;
        buildUI();
        updateBtnCount();
      }
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
