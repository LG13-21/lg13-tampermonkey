# lg13-tampermonkey

Userscripts pro lokální LG13 systém. Beží v prohlížeči (Tampermonkey extension), posílají data do `pl_server` (`127.0.0.1:8790`).

## Skripty

| Soubor | Verze | Účel |
|---|---|---|
| `lg13_chatgpt_ingest.user.js` | 1.6 | Auto-capture ChatGPT konverzací (`chatgpt.com`, `chat.openai.com`) → `/pl/chatgpt/ingest`. v1.6 fix `user-select:none` na assistant zprávách. |
| `lg13_suno_uploader.user.js` | 2.5 | Server-driven: aplikuje upravené texty z LG13 na Suno songy a triggeruje download. |
| `lg13_suno_catalog.user.js` | 6.5 | Capture Suno playlistu + auto-fetch detailů (lyrics, tags, plays, likes) přes /song/ stránky. |

## Instalace

1. Tampermonkey extension (Chrome/Edge/Firefox)
2. Create script → paste obsah `.user.js` → Save
3. Otevři odpovídající doménu

## Backend

Skripty volají lokální `pl_server` (port 8790). Server source v hlavním LG13 repu (private).

## Bezpečnost

- `@connect 127.0.0.1` — žádná externí komunikace mimo localhost
- `@grant GM_xmlhttpRequest` — povolí cross-origin POST na lokální server
- Žádné credentials v skriptech
