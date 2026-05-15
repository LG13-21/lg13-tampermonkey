// ==UserScript==
// @name         ChatGPT Adaptive Reload
// @namespace    local.chatgpt
// @version      1.6
// @description  Adaptive page reload — Edge only, reload jen v idle, MIN 5 min [v1.6: Edge-only guard (nespouštět v FF/Chrome kde Tom pracuje)]
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_adaptive_reload.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_adaptive_reload.user.js
// ==/UserScript==

// PATCH v1.5 (coder, 2026-05-11):
//   isTyping() teď vrací true POUZE pokud composer obsahuje text. ChatGPT
//   defaultně dává focus na input box (i prázdný) → v1.4 isTyping = true →
//   reload se navždy přeskakoval. Tom nahlásil "nedela refresh". Fix: empty
//   input box ≠ typing. Plus přidán FORCE_RELOAD_AFTER safety net (45 min)
//   pro případ že tick někde zatuhne.

// PATCH v1.2 (coder, 2026-05-11):
//   3 fixes: ACTIVITY no-reload, no HARD_STOP, MIN 5min.

// PATCH v1.1 (coder, 2026-05-09):
//   localStorage seen + 30min floor (pre-classifier dedup).

(function () {
'use strict';

// Edge-only guard — nespouštět v Firefox ani Chrome kde Tom pracuje
if (!/Edg\//.test(navigator.userAgent)) return;

const MIN_INTERVAL       = 5 * 60 * 1000;     // 5 min
const MAX_INTERVAL       = 60 * 60 * 1000;    // 1 h
const STEP               = 60 * 1000;         // +1 min per idle tick
const FORCE_RELOAD_AFTER = 45 * 60 * 1000;    // hard safety: reload po 45 min bez ohledu

let currentInterval = MIN_INTERVAL;
let lastMessageCount = 0;
let pageLoadedAt = Date.now();

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
    // Empty composer != typing. ChatGPT default-focuses the composer even
    // when Tom isn't writing; without this we'd never reload.
    const val = (el.value !== undefined)
        ? el.value
        : (el.innerText || el.textContent || '');
    return val.trim().length > 0;
}

function tick() {
    const sinceLoad = Date.now() - pageLoadedAt;

    if (isGenerating()) {
        console.log('[AdaptiveReload] generating, skip (age ' + Math.round(sinceLoad/1000) + 's)');
        scheduleNext();
        return;
    }

    if (isTyping()) {
        console.log('[AdaptiveReload] composer has draft, skip (age ' + Math.round(sinceLoad/1000) + 's)');
        scheduleNext();
        return;
    }

    // Hard safety net: po 45 min od load reload bez ohledu na count delta.
    if (sinceLoad >= FORCE_RELOAD_AFTER) {
        console.log('[AdaptiveReload] FORCE reload — page age ' + Math.round(sinceLoad/60000) + 'min');
        location.reload();
        return;
    }

    const count = getMessageCount();
    if (count > lastMessageCount) {
        console.log('[AdaptiveReload] activity (' + lastMessageCount + ' -> ' + count + '), no reload');
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
console.log('[AdaptiveReload v1.5] started — MIN=5min, MAX=60min, FORCE=45min, baseline=' + lastMessageCount);
scheduleNext();

})();
