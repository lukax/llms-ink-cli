# llms-ink

Turn any link — a website, docs section, page, GitHub repo, PDF or video — into [llms.txt](https://llmstxt.org) and
llms-full.txt your model can read. The command line for [llms.ink](https://llms.ink). No account, no key needed.

```sh
npx @lukax/llms-ink developers.cloudflare.com/kv/
# or install it
npm install -g @lukax/llms-ink
llms-ink github.com/honojs/hono --full > hono.txt
```

Quote links that contain `?` or `&` (zsh and bash treat them specially).

## Commands

| Command | What it does |
|---|---|
| `llms-ink <link>` | Prints llms.txt: the site's own if it publishes one, otherwise built from the page, sitemap or repo |
| `llms-ink <link> --full` | Prints llms-full.txt: the index plus the Markdown of up to 20 pages it links to (videos: the transcript) |
| `llms-ink frame <video>` | Saves a frame of a video as JPEG (`-t 1:30`, `-w 640`) |
| `llms-ink media <video>` | Downloads the video as MP4, or its audio as M4A with `--audio` |
| `llms-ink check <site>` | Checks a site's published llms.txt: format, sections and its first 25 links. Exits `1` on errors or broken links |
| `llms-ink check <file\|->` | Checks a local llms.txt (a file, or `-` for stdin) before you publish it. Its links are checked with `--links` |
| `llms-ink parse <file\|-\|link>` | Prints an llms.txt's title, summary, and each section with its links. Exits `1` when there's no llms.txt or no `# ` title |
| `llms-ink report <link>` | What AI crawlers and agents see on a page: robots.txt per AI bot, firewall blocks, text without JavaScript, Markdown, retrieval basics, agent files; each problem with its fix. Exits `1` on any `fail` |
| `llms-ink generate <kind> <link>` | Drafts for you to review, built only from the source. `agents-md`: an AGENTS.md for a GitHub repo or docs site, each line ending with its source file and line. `jsonld`: a JSON-LD array (WebSite, Organization, Product, SoftwareApplication) of facts found on the site. `alt-text`: `alt="…"` for images without it. `answers`: a question heading and answer-first sentence per H2 section. Notes (what was found or rejected) go to stderr. Counts as a new link |
| `llms-ink context` | Writes version-pinned docs for your dependencies, trimmed to the APIs your code imports, to `.context/` and links them from AGENTS.md. [Details](#docs-for-your-dependencies-context) |

## Options

| Option | |
|---|---|
| `--full` | llms-full.txt instead of llms.txt |
| `--fresh` | Rebuild instead of using the 24-hour cache (counts as a new link); also for `generate` |
| `--generated` | Always generate, never return the site's own llms.txt. Use it when your site's llms.txt comes from llms.ink |
| `-o, --output <path>` | A file, a folder (created when it ends in `/`), or `-` for stdout |
| `-t, --time <t>` | `frame`: when — `90`, `1:30`, `1:02:03` |
| `-w, --width <px>` | `frame`: maximum width, 160–1920 (default 1280) |
| `--audio` | `media`: the audio only |
| `--json` | The whole answer as JSON: for llms.txt url, kind, source, mode, title, text, tokens, pages, model, cached; for `check` the full report; for `parse` the parsed file (title, summary, details, sections and their links); for `report` every check with its fix and patch; for `generate` the drafts with their cites, sources and notes |
| `--base <url>` | `check`, `parse` with a file or `-`: the file's public URL. Resolves relative links and heads the report |
| `--links` | `check` with a file or `-`: also check its first 25 links, and llms-full.txt next to `--base` |
| `--quiet` | Nothing on stderr but errors |
| `--api <url>` | Another API base URL (also `LLMS_INK_API`) |
| `--key <key>` | Optional API key for higher limits (also `LLMS_INK_KEY`), sent as `Authorization: Bearer` |

## Examples

```sh
llms-ink docs.stripe.com/payments | pbcopy
llms-ink 'https://youtube.com/watch?v=zjkBMFhNj_g' --full -o talk.txt
llms-ink https://arxiv.org/pdf/1706.03762 --full
llms-ink frame 'https://youtu.be/jNQXAC9IVRw' -t 0:12 -o zoo.jpg
llms-ink llmstxt.org --json | jq .tokens
llms-ink example.com --generated -o public/llms.txt   # refresh your own, e.g. at build time
llms-ink check example.com || echo 'fix your llms.txt'
llms-ink check public/llms.txt --base https://example.com/llms.txt --links   # in CI, before deploying
llms-ink report example.com/pricing --json | jq -r 'first(.sections[].checks[] | select(.fix.patch.file? == "/robots.txt") | .fix.patch.content)' > robots.txt.new
llms-ink generate agents-md github.com/you/repo -o AGENTS.md   # then review: every line ends with <!-- file:line -->
llms-ink generate jsonld example.com > jsonld.json
cat llms.txt | llms-ink parse - --json | jq '.sections[].links[].url'
```

`check` and `parse` send a file's text when the argument is `-` or an existing file; anything else is a link. A missing
path (`./…`, `/…`, `~/…`, or a folder path ending in `.txt`/`.md` such as `public/llms.txt`) exits `2` with
`No such file`; `example.com/llms.txt` is a link. Checking text doesn't count toward the daily links.

Progress and a one-line summary (kind · source · tokens · links) go to stderr; stdout gets only the file, so it pipes
cleanly. `check`, `parse` and `report` print their report on stdout. Exit codes: `0` done, `1` failed (the reason is printed),
`check` found errors or broken links, `parse` found nothing to parse, or `report` found a `fail`, `2` wrong usage.

## Docs for your dependencies (`context`)

```sh
llms-ink context                                   # the manifests in this folder
llms-ink context -m package.json -m api/pyproject.toml --max 5 --out .context --agents-md AGENTS.md
```

1. **Versions** come from the lockfile next to each manifest (or in a parent folder, for workspaces):
   `package-lock.json`/`npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` (classic and Berry); `uv.lock`,
   `poetry.lock`, `pdm.lock`, then `==` pins in `requirements*.txt`; `Cargo.lock` (the highest locked version the
   requirement accepts); `go.mod`'s `require` (already the selected version, so `go.sum` isn't needed). An exact
   version in the manifest counts too. Direct dependencies only; local, git and URL ones are listed as not included.
2. **Docs for that version**: `docs.rs/<crate>/<version>`, `pkg.go.dev/<module>@<version>`, a registry docs URL
   that names the version (or Read the Docs `/en/<version>/` when it exists), else the GitHub repo at the release
   tag (`v1.2.3`, `1.2.3`, `name@1.2.3`, … from the repo's tag list; npm's publish commit when no tag matches),
   read through llms.ink's repo reader with `/tree/<tag>`. Otherwise the latest docs, marked **unpinned** with why.
3. **Trimmed to your code**: imports and the names used through them (JS/TS `import`/`require`, Python
   `import`/`from`, Rust `use` and `crate::` paths, Go imports) pick the sections that mention them; docs pages come
   before housekeeping pages and changelogs. The page list stays as an index. About `--tokens` (6000) per package.
4. **Output**: `.context/<package>@<version>.md` (`/` in names becomes `__`; `@latest` when no version resolved),
   with front matter `package`, `ecosystem`, `version`, `version-from`, `docs` (`pinned`/`unpinned`), `sources`
   (the docs URL and the registry record), `uses`, `tokens`; `.context/README.md` lists every file and what was left
   out and why; AGENTS.md (created if missing; `--agents-md none` to skip) gets a block between
   `<!-- llms-ink:context:start -->` and `<!-- llms-ink:context:end -->`, the rest of the file untouched.

There's no timestamp anywhere, and generated indexes are rebuilt from the page list in URL order, so a rerun with
the same lockfile, code and upstream docs writes the same bytes: a diff means a version or the docs changed (or,
after llms.ink's 24-hour cache, a rebuilt repo index that picked a different set of pages). Files
for versions you no longer use are removed (only files with this command's front matter). When a read fails (a
daily limit, a site that's down), the package's earlier file stays and the reason is listed; the exit code is `1`
only when every read failed. Packages are ranked by how many files import them, so `--max` keeps the ones your code
uses most. Each package read is one link toward the daily limit; dependency names go to the public registries and
GitHub, never your code, and `LLMS_INK_KEY` goes only to llms.ink.

## Limits

Public links only. 60 new links a day per person; cached links (24 h) are free. A free API key raises that to 1000 a
day: ask for one on [llms.ink/about](https://llms.ink/about/#limits). More at [llms.ink/docs](https://llms.ink/docs/),
including the MCP server.

## Hosted inspection (experimental, 0.6.0)

```sh
# Set LLMS_INK_INSPECT_KEY in your environment first.
llms-ink inspect --file .context/project.md
llms-ink inspect --file tools.json --output inspection-receipt.json
```

Requires an inspection-enabled pilot key. This explicitly uploads one `.md`, `.txt` or `.json` file inside the current folder. No crawl, globs, stdin or symlinks. JSON is inspected as exact UTF-8 text, including whitespace; its receipt digest matches the file bytes. Existing retrieval/context commands do not enable inspection.

Output is receipt JSON with no source text. Exit 0 means complete/no finding; exit 1 means flagged, incomplete or failed; exit 2 means invalid input/setup. Any nonzero exit must stop delivery. A receipt is unsigned and no finding is not a safety guarantee. Changed bytes require another scan.

`--output` writes a private receipt file without overwriting; parent directories must already exist. Failures remove the temporary output. The command validates the receipt digest, revisions, coverage and token counters. Redirects are refused; `LLMS_INK_API`, `--api` and `--key` cannot change inspection transport. Use `LLMS_INK_INSPECT_KEY` (fallback `LLMS_INK_KEY`), not a key on the command line. No automatic retries; admitted attempts consume pilot allowance. Requests have a 65-second deadline and a 128 KiB limit after encoding. Ctrl+C cancels the request.

See [pilot access, limits and content handling](https://llms.ink/inspect/).
