# Changelog

## 0.7.1 — 2026-11-15

- Validate context output paths, locked versions and AGENTS merge markers before fetching or writing. Refuse symlinks, hard links, unmanaged destination collisions and overlapping output paths.
- Check for output changes after fetching; replace individual files atomically and retain unrelated files. Pack-wide rollback and hostile concurrent directory replacement are outside this boundary.
- Add regression cases reproducing the prior redirected writes and partial updates. Context generation remains separate from hosted inspection.
