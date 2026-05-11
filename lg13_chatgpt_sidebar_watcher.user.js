// ==UserScript==
// @name         ChatGPT Sidebar Watcher
// @namespace    local.chatgpt
// @version      1.1
// @description  Watch sidebar for keywords, open matching threads — patched seen->localStorage (anti-reopen)
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_notification
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/coder/anti-spam-2026-05-09/lg13_chatgpt_sidebar_watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/coder/anti-spam-2026-05-09/lg13_chatgpt_sidebar_watcher.user.js
// ==/UserScript==

// PATCH v1.1 (coder, 2026-05-09):
//   `seen` Set -> localStorage-backed — survives page reloads (Adaptive Reload
//   triggers reload every 30min). Without persistence, after each reload Set
//   is empty -> all matching threads re-open as new tabs -> tab fork-bomb.
//   localStorage shared across same-origin tabs/reloads.

(function () {
'use strict';

const CHECK_INTERVAL = 5000;
const SEEN_KEY = 'lg13_sidebar_watcher_seen_v1';

const WATCH_KEYWORDS = [
    'F15',
    'freeze',
    'OSPOD',
    'review'
];

function loadSeen() {
    try {
        const raw = localStorage.getItem(SEEN_KEY);
        return new Set(raw ? JSON.parse(raw) : []);
    } catch (_) {
        return new Set();
    }
}

function saveSeen(seenSet) {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...seenSet]));
    } catch (_) {}
}

const seen = loadSeen();

function getThreads() {
    const links = document.querySelectorAll('a[href*="/c/"]');
    return [...links].map(link => ({
        title: link.innerText.trim(),
        href: link.href
    }));
}

function shouldWatch(title) {
    const lower = title.toLowerCase();
    return WATCH_KEYWORDS.some(
        k => lower.includes(k.toLowerCase())
    );
}

function openThread(thread) {
    if (seen.has(thread.href)) {
        return;
    }
    seen.add(thread.href);
    saveSeen(seen);

    console.log('[Watcher] opening:', thread.title);
    window.open(thread.href, '_blank');

    if (typeof GM_notification !== 'undefined') {
        GM_notification({
            title: 'ChatGPT Watcher',
            text: thread.title,
            timeout: 4000
        });
    }
}

function scan() {
    const threads = getThreads();
    threads.forEach(thread => {
        if (!thread.title) return;
        if (shouldWatch(thread.title)) {
            openThread(thread);
        }
    });
}

console.log('[Watcher v1.1] started — seen=' + seen.size + ' (localStorage)');
setInterval(scan, CHECK_INTERVAL);

})();
