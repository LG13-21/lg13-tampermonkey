---
name: cge-search
description: "Fulltextové vyhledávání napříč ChatGPT JSON exporty (ChatGPT_export/*.json, 500+ souborů) a atom daily store (atoms/daily/*.json) podle klíčového slova nebo conv_id, bez ručního otevírání jednotlivých souborů. Trigger: 'najdi v exportech', 'hledej v chatgpt json', 'cge search', 'kde jsme o tomhle mluvili', 'najdi vlákno podle textu', 'prohledej ChatGPT_export'."
user-invocable: true
---

# CGE-Search — fulltextové hledání v ChatGPT JSON exportech

## ÚČEL

Dva lokální JSON store se stejným obsahem (ChatGPT konverzace), různým schématem:

1. **CGE raw export** — `L:/GitHub/legal-ship-2026/ChatGPT_export/*.json` (přes 500 souborů, jeden = jedno vlákno)
   ```json
   {"metadata": {"title": "...", "link": "https://chatgpt.com/c/<conv_id>", "dates": {...}},
    "messages": [{"role": "Prompt"|"Response", "say": "...", "time": "M/D/YYYY, H:MM:SS AM/PM"}]}
   ```
   Ne každý `.json` v té složce je export vlákna — složka obsahuje i pomocné soubory (review matrice, verdict extrakty) bez klíče `messages`. Ty se automaticky přeskočí.

2. **Atom daily store** — `L:/LG13/atoms/daily/YYYY-MM-DD.json` — top-level list atomů, text je v `lg13_meta.lg13_ctx` (ne v `content`/`text`, ty jsou typicky prázdné).

Skript `cge_search.py` prohledá oba formáty jedním dotazem.

## EXECUTION

```bash
python L:/GitHub/lg13-coder/agent/skills/cge_search.py --query "hledaný text" --source both --limit-hits 20
python L:/GitHub/lg13-coder/agent/skills/cge_search.py --conv-id 6a86c7a9-5154-83ed-9bde-6c23b9fab3e3 --source both
python L:/GitHub/lg13-coder/agent/skills/cge_search.py --query "text" --source cge --limit-files 100   # jen posledních 100 souborů (rychlejší)
```

Parametry: `--query` (case-insensitive substring, ne regex), `--conv-id` (substring z `chatgpt.com/c/<id>`), `--source cge|atoms|both`, `--limit-files` (0=vše, jinak N nejnovějších souborů dle mtime/jména), `--limit-hits` (max 100, **sdílený strop napříč oběma zdroji** — u `--source both` se nejdřív vyčerpá CGE, zbytek stropu jde na atoms, ne 100+100). Musíš zadat aspoň jedno z `--query`/`--conv-id`. Výsledky jsou řazené od nejnovějšího souboru (CGE dle mtime, atoms dle jména `YYYY-MM-DD.json`), ne dle relevance ani chronologicky uvnitř vlákna.

## GOTCHAS

- **Windows konzole + diakritika:** bez `sys.stdout.reconfigure(encoding='utf-8')` na začátku skriptu spadne `UnicodeEncodeError` (cp1252) na jakémkoliv českém textu. `cge_search.py` to řeší, ale pokud píšeš vlastní jednorázový Python nad těmito soubory, přidej to taky.
- **`messages` vs jiné klíče:** soubor bez top-level klíče `messages` v CGE složce není konverzace — skript ho přeskočí, ty to udělej taky (`if not isinstance(data, dict) or 'messages' not in data: continue`).
- **Atom text pole:** v atom store hledej v `lg13_meta.lg13_ctx`, ne v `content`/`text` (ty bývají prázdné stringy).
- Nativní OpenAI export formát (`{"mapping": {...}}`) se v aktuální `ChatGPT_export/` složce nevyskytuje (ověřeno na všech 509 json souborech, 2026-09-01) — pokud by se objevil, `cge_search.py` ho zatím nepokrývá, potřeba doplnit větev pro `mapping`.

## RELATED

- `atom-search` — přesnější nástroj když už znáš `conv_id` a chceš chronologicky seřazené atomy přes `atom_lookup.py`/`pl_server` (má i time-window filtr). `cge-search` je pro fulltextové hledání KDYŽ conv_id neznáš.
- `chatgpt-search` / `chatgpt-find` — živé hledání v ChatGPT UI přes CDP/Playwright, použij když vlákno ještě nebylo exportováno/ingestováno do `ChatGPT_export/`.
- `atom-read-all` — po nalezení atomu vždy přečti obsah před routing rozhodnutím.

## Poznámka k tomuto repu

Tento soubor je git-verzovaná kopie skillu, jehož "živá" instance (načítaná Claude Code Skill toolem) leží v `C:\Users\tom\.claude\plugins\marketplaces\lg13\plugins\lg13-skills\skills\cge-search\`. Sem je nahraný jen kód/dokumentace — **žádná data z `ChatGPT_export/` ani `atoms/daily/` se sem nekopírují** (obsahují osobní/soudní materiál, patří do privátního repa `legal-ship-2026`, ne do tohoto veřejného).
