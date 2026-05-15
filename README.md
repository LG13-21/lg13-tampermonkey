# lg13-tampermonkey

Userscripts pro lokální LG13 systém. Běží v prohlížeči (Tampermonkey extension), posílají data do `pl_server` (`127.0.0.1:8790`).

## Skripty

| Soubor | Verze | Účel |
|---|---|---|
| `lg13_chatgpt_ingest.user.js` | 4.9+ | Auto-capture ChatGPT konverzací → `/pl/chatgpt/ingest`. LG13_META trailer + ATOM split markers. |
| `lg13_chatgpt_executor.user.js` | 1.2 | Obrácený ingest: server → ChatGPT input. Polluje `/pl/chatgpt/commands` + DOM state heartbeat (`/pl/chatgpt/state`). |
| `lg13_chatgpt_sidebar_watcher.user.js` | — | Sleduje změny v ChatGPT sidebaru (nová vlákna, přejmenování) → `/pl/chatgpt/sidebar`. Doplněk pro `atom_dispatcher`. |
| `lg13_chatgpt_adaptive_reload.user.js` | — | Auto-reload ChatGPT stránky při detekci zaseknutí (stuck spinner, timeout). Zajišťuje dostupnost bez manuálního zásahu. |
| `lg13_chatgpt_full_loader.user.js` | — | Načte celou historii konverzace (scroll-to-top) před ingestem. Potřebné pro dlouhá vlákna kde lazy-load nestihne ingest. |
| `lg13_claude_usage.user.js` | 2.4+ | Scrape `claude.ai/settings/usage` token limits → `/pl/usage/ingest`. **Public twin v `lg13-runtime-state` repu (v2.5).** |
| `lg13_suno_catalog.user.js` | 6.6 | Capture Suno playlistu + auto-fetch detailů (lyrics, tags, plays, likes) přes /song/ stránky. |
| `lg13_suno_uploader.user.js` | 2.6 | Server-driven: aplikuje upravené texty z LG13 na Suno songy a triggeruje download. |

## Instalace

1. Tampermonkey extension (Chrome / Edge / Firefox)
2. Create script → paste obsah `.user.js` → Save (NEBO klik na raw GitHub URL → TM nabídne install)
3. Otevři odpovídající doménu

## Autoupdate

Všechny skripty mají nastavené `@updateURL` + `@downloadURL` na `raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/<file>.user.js`. Repo je public, raw URL funguje bez auth.

**Firefox**: autoupdate funguje pro všechny skripty by default (24h interval).

**Chrome**: autoupdate funguje **pouze pokud byl skript nainstalován s @updateURL již v hlavičce**. Skripty instalované před přidáním autoupdate hlaviček musí Tom **jednorázově re-installnout** (klik na raw URL → TM nabídne update). Od té chvíle Chrome už autoupdatuje.

### Manuální kontrola updatů

Tampermonkey ikonka → Dashboard → klik na skript → tab „Settings" → tlačítko **„Check for updates"**.

### Globální interval

Tampermonkey Settings → Externals → **Update Interval** = 6 (hodiny). Default 24h, doporučeno 6h pro LG13 (rychlejší propagace fixů).

## Verzování

Každá změna = bump `@version` v hlavičce (per memory `feedback_always_bump_version`). Bez bumpu autoupdate nepozná že je nová verze.

## Backend

Skripty volají lokální `pl_server` (port 8790). Server source v hlavním LG13 repu (private).

## Alternativní vyhledávání (bez TM)

Pokud TM nefunguje nebo potřebuješ prohledat historii offline:

- **`cgpt_find.py`** — Playwright CDP scraper, search form + snippety: `python L:/LG13/app/agent/skills/cgpt_find.py "query" --json`
- **`git-tmonkey-search` skill** — full-text přes ingestovaná vlákna v git historii (offline)
- **`rag-search` skill** — RAG přes lokální embedding databázi (4 měsíce historie TXT)

## Přispívání

Viz [CONTRIBUTING.md](CONTRIBUTING.md). Licence: [MIT](LICENSE).

## Bezpečnost

- `@connect 127.0.0.1` (lokální) + `@connect chatgpt.com` / `chat.openai.com` / `suno.com` / `claude.ai` (per skript) — povolené domény jsou explicit, nic mimo
- `@grant GM_xmlhttpRequest` — povolí cross-origin POST na lokální server
- Žádné credentials v skriptech
- Repo public, ale skripty NEčtou žádné credentials z DOM (claude_usage čte jen UI gauges, chatgpt_ingest čte text konverzace — žádné session cookies/tokens)

## Související public repo

- **`lg13-runtime-state`** — share-ready balíček pro Claude Code Routines (`lg13_claude_usage.user.js` v2.5 + standalone Python tools + paste-ready Routine instructions). [LG13-21/lg13-runtime-state](https://github.com/LG13-21/lg13-runtime-state)
