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

## Options

| Option | |
|---|---|
| `--full` | llms-full.txt instead of llms.txt |
| `--fresh` | Rebuild instead of using the 24-hour cache (counts as a new link) |
| `--generated` | Always generate, never return the site's own llms.txt. Use it when your site's llms.txt comes from llms.ink |
| `-o, --output <path>` | A file, a folder (created when it ends in `/`), or `-` for stdout |
| `-t, --time <t>` | `frame`: when — `90`, `1:30`, `1:02:03` |
| `-w, --width <px>` | `frame`: maximum width, 160–1920 (default 1280) |
| `--audio` | `media`: the audio only |
| `--json` | The whole answer as JSON: for llms.txt url, kind, source, mode, title, text, tokens, pages, model, cached; for `check` the full report; for `parse` the parsed file (title, summary, details, sections and their links) |
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
cat llms.txt | llms-ink parse - --json | jq '.sections[].links[].url'
```

`check` and `parse` send a file's text when the argument is `-` or an existing file; anything else is a link. A missing
path (`./…`, `/…`, `~/…`, or a folder path ending in `.txt`/`.md` such as `public/llms.txt`) exits `2` with
`No such file`; `example.com/llms.txt` is a link. Checking text doesn't count toward the daily links.

Progress and a one-line summary (kind · source · tokens · links) go to stderr; stdout gets only the file, so it pipes
cleanly. `check` and `parse` print their report on stdout. Exit codes: `0` done, `1` failed (the reason is printed),
`check` found errors or broken links, or `parse` found nothing to parse, `2` wrong usage.

## Limits

Public links only. 60 new links a day per person; cached links (24 h) are free. A free API key raises that to 1000 a
day: ask for one on [llms.ink/about](https://llms.ink/about/#limits). More at [llms.ink/docs](https://llms.ink/docs/),
including the MCP server.
