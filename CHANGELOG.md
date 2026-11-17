# Changelog

## 0.9.0 — 2026-11-17

- Add `init`: write a reviewed GitHub workflow (`--github --url`, the default) that runs `lukax/llms-txt-action@v1` in PR mode after a production deployment, or the hosted MCP server in `.mcp.json` (`--mcp`). It shows each file as a diff, `--dry-run` writes nothing, and a differing file is never replaced without `--force`.
- After writing, `init` sends one anonymous count of the surfaces it wrote (`github`, `mcp`); no site, repository or path. `--dry-run` sends nothing; `DO_NOT_TRACK=1` skips it. The written MCP URL carries `?source=init`.
- API requests send `User-Agent: llms-ink-cli/<version>`.

## 0.8.0 — 2026-11-15

- Add explicit `context inspect --dir --dry-run` previews and hosted whole-pack inspection with private, exclusive manifests. Record exact file bytes/digests, declared sources, validated receipts and partial failures; never upload during generation.
- Add offline `context verify --dir --receipt`: reject changed file sets, changed bytes, unsupported receipts and incomplete runs. Records remain unsigned and cannot grant tool authority or establish content safety.
- Bound the complete selected tree before uploads; refuse links and unsupported files. Pace requests without retries and preserve interrupted results on SIGINT/SIGTERM.

## 0.7.2 — 2026-11-15

- Validate context output paths, locked versions and AGENTS merge markers before fetching or writing. Refuse symlinks, hard links, unmanaged destination collisions and overlapping output paths.
- Check for output changes after fetching; replace individual files atomically and retain unrelated files. Pack-wide rollback and hostile concurrent directory replacement are outside this boundary.
- Add regression cases reproducing the prior redirected writes and partial updates. Context generation remains separate from hosted inspection.

The v0.7.1 tag was cancelled before publication after static checks identified a deprecated `process.umask()` getter. Version 0.7.2 lets file creation apply the mask atomically and preserves an existing file's permissions without reading the process-wide mask. The old tag is unchanged.
