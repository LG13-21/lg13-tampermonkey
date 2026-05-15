# Contributing to lg13-tampermonkey

## Quick start

1. Fork → clone → create branch `fix/<name>` or `feat/<name>`
2. Edit the `.user.js` file
3. **Bump `@version`** in the script header — autoupdate won't fire without it
4. Test in browser (Tampermonkey → paste updated script)
5. PR → main

## Script header requirements

Every script must have:

```javascript
// @name         lg13_<script_name>
// @namespace    https://github.com/LG13-21/lg13-tampermonkey
// @version      X.Y
// @description  <one line>
// @author       LG13-21
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/<file>.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/<file>.user.js
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
```

Additional `@connect` entries only for domains the script actually reads from.

## Backend

Scripts POST to `http://127.0.0.1:8790` (local `pl_server`). The server is part of the private LG13 agent system. For testing without a live server, mock responses at that port.

## Versioning

- Patch fix → bump minor: `4.8` → `4.9`
- New feature → bump major: `4.9` → `5.0`
- Breaking change in payload schema → bump major + update README

## Security checklist before PR

- [ ] No hardcoded credentials or tokens
- [ ] `@connect` list is minimal (only domains actually used)
- [ ] `@grant` list is minimal
- [ ] No `eval()` or dynamic code execution
- [ ] Personal data (conversation content) stays local — never sent to 3rd parties

## Issues

Bug reports and feature requests welcome via GitHub Issues.
Label: `bug` / `enhancement` / `question`.
