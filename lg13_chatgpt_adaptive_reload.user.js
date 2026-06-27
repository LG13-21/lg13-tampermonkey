// ==UserScript==
// @name         ChatGPT Adaptive Reload
// @namespace    local.chatgpt
// @version      1.7
// @description  Adaptive page reload — reload jen v idle, no hard-stop, MIN 5 min [v1.7: reload jen po 15 min kompletního idle (scroll/mouse/click reset timer)]
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_adaptive_reload.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_adaptive_reload.user.js
// ==/UserScript==

// PATCH v1.7 (coder, 2026-06-27):
//   ACTIVITY_THRESHOLD zvýšen na 15 min. Reload nastane jen pokud user byl
//   kompletně idle (žádný scroll/mouse/click/keydown) po dobu 15 minut.
//   Čtení konverzace = scrollování = aktivita → no reload.

// PATCH v1.6 (coder, 2026-06-27):
//   Přidán activity tracker (scroll, mousemove, click, keydown).
//   Fix pro případ čtení: scroll = aktivita → no reload.

// PATCH v1.5 (coder, 2026-05-11):
//   isTyping() teď vrací true POUZE pokud composer obsahuje text.

// PATCH v1.2 (coder, 2026-05-11):
//   3 fixes: ACTIVITY no-reload, no HARD_STOP, MIN 5min.

// PATCH v1.1 (coder, 2026-05-09):
//   localStorage seen + 30min floor (pre-classifier dedup).

(function () {
'use strict';

const MIN_INTERVAL       = 5 * 60 * 1000;     // 5 min
const MAX_INTERVAL       = 60 * 60 * 1000;    // 1 h
const STEP               = 60 * 1000;         // +1 min per idle tick
const FORCE_RELOAD_AFTER = 90 * 60 * 1000;    // hard safety: reload po 90 min
const ACTIVITY_THRESHOLD = 15 * 60 * 1000;    // 15 min — reload jen po 15 min kompletního idle

let currentInterval = MIN_INTERVAL;
let lastMessageCount = 0;
let pageLoadedAt = Date.now();
let lastActivity = Date.now();

// Sledování aktivity uživatele
function trackActivity() {
    lastActivity = Date.now();
}
document.addEventListener('scroll',    trackActivity, { passive: true, capture: true });
document.addEventListener('mousemove', trackActivity, { passive: true });
document.addEventListener('click',     trackActivity, { passive: true });
document.addEventListener('keydown',   trackActivity, { passive: true });
document.addEventListener('touchstart',trackActivity, { passive: true });

function getMessageCount() {
    return document.querySelectorAll('[data-message-author-role]').length;
}

function isGenerating() {
    return !!document.querySelector('[data-testid="stop-button"]');
}

function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const isInput = (el.tagName === 'TEXTAREA' ||
                     el.tagName === 'INPUT' ||
                     el.isContentEditable);
    if (!isInput) return false;
    const val = (el.value !== undefined)
        ? el.value
        : (el.innerText || el.textContent || '');
    return val.trim().length > 0;
}

function tick() {
    const now = Date.now();
    const sinceLoad = now - pageLoadedAt;
    const idleSince = now - lastActivity;

    if (isGenerating()) {
        console.log('[AdaptiveReload] generating, skip');
        scheduleNext();
        return;
    }

    if (isTyping()) {
        console.log('[AdaptiveReload] composer has draft, skip');
        scheduleNext();
        return;
    }

    // Uživatel byl aktivní v posledních 2 minutách → přeskoč reload
    if (idleSince < ACTIVITY_THRESHOLD) {
        console.log('[AdaptiveReload] user active ' + Math.round(idleSince/1000) + 's ago, skip');
        currentInterval = MIN_INTERVAL; // reset intervalu — byl aktivní
        scheduleNext();
        return;
    }

    // Hard safety net po 90 min
    if (sinceLoad >= FORCE_RELOAD_AFTER) {
        console.log('[AdaptiveReload] FORCE reload — page age ' + Math.round(sinceLoad/60000) + 'min');
        location.reload();
        return;
    }

    const count = getMessageCount();
    if (count > lastMessageCount) {
        console.log('[AdaptiveReload] new messages (' + lastMessageCount + ' -> ' + count + '), no reload');
        lastMessageCount = count;
        currentInterval = MIN_INTERVAL;
        scheduleNext();
        return;
    }

    currentInterval = Math.min(currentInterval + STEP, MAX_INTERVAL);
    console.log('[AdaptiveReload] idle reload (age ' + Math.round(sinceLoad/1000) + 's, next ' + currentInterval/1000 + 's)');
    location.reload();
}

function scheduleNext() {
    setTimeout(tick, currentInterval);
}

lastMessageCount = getMessageCount();
console.log('[AdaptiveReload v1.7] started — MIN=5min, MAX=60min, FORCE=90min, ACTIVITY_THRESHOLD=15min, baseline=' + lastMessageCount);
scheduleNext();

})();
