# Daily YouTube Digest — Project Guide

## Purpose
Automatically collect, summarize, and publish YouTube video summaries from watched channels every morning. GitHub Actions uses Gemini for summarization.

## Tech Stack
- Runtime: Node.js v22+
- YouTube data: yt-dlp (CLI tool)
- AI summarization: **Gemini API** in GitHub Actions with automatic fast/flash model fallback
- Output: Markdown files + optional Notion API

## Workflow Overview
1. **Collect** (Node script) — yt-dlp fetches yesterday's videos + transcripts
2. **Summarize** (Gemini) — `scripts/summarize-gemini.js` reads raw JSON and writes summaries following `config/format.md`
3. **Review** (Node script) — Validates structure, Korean output, unique insights, 3-item timelines, and timestamp coverage
4. **Publish** (Node script) — Saves to `output/YYYY-MM-DD.md` and optionally Notion

## Useful Commands
```bash
npm test                 # setup/pipeline smoke test
npm run collect          # daily/yesterday collection
npm run collect:week     # last 7 days, max 3 videos/channel
npm run collect:channel -- @handle 10
```

## Trigger Phrases

### Daily — "어제 거 요약해 줘" / "daily digest" / "run digest"
Yesterday only. Use `npm run collect` (single day).

### Weekly — "지난 일주일 요약해 줘" / "weekly digest" / "지난 7일"
Last 7 days. Use `npm run collect:week` instead of `npm run collect`. Everything else is identical — review.js and publish.js auto-detect the latest tmp file. Notion title is auto-formatted as "Weekly Digest".

### Channel — "channel digest" / "이 채널 요약해 줘"
Use the `[MANUAL] Channel YouTube Digest` workflow or `node --env-file-if-exists=.env scripts/collect.js --channel @handle --limit 10`.

When the trigger fires, execute this sequence:

### Step 1: Collect
```bash
npm run collect           # daily (yesterday)
# or
npm run collect:week      # weekly (last 7 days)
```
Creates `tmp/raw-{key}.json` where key is either `YYYY-MM-DD` or `YYYY-MM-DD_to_YYYY-MM-DD`.

### Step 2: Summarize
GitHub Actions runs `npm run summarize`, which uses `GEMINI_API_KEY`, tries `GEMINI_MODEL=gemini-3-fast` first, lists available models, and falls back to the fastest available Gemini flash/fast model that supports `generateContent`.

### Step 3: Review
```bash
npm run review
```

### Step 4: Publish
```bash
npm run publish
```

### Step 5: Report
Tell the user the output file path, channel/video counts, and any errors.

## Sub-Agent Reference Files
- `agents/collector.md` — yt-dlp usage and data shape
- `agents/summarizer.md` — summarization tone, audience, language rules
- `agents/reviewer.md` — quality checks
- `agents/publisher.md` — output destinations

## Config Files
- `config/channels.txt` — One YouTube channel handle per line (e.g., `@Ezurio`)
- `config/format.md` — Required output format for each summary
- `config/keywords.txt` — Optional: only include videos matching these keywords

## Environment Variables (optional)
```
GEMINI_API_KEY=...            # Required: Gemini summarization
GEMINI_MODEL=gemini-3-fast    # Optional: preferred model
GEMINI_MODEL_FALLBACKS=...    # Optional: comma-separated fallback model list
YOUTUBE_COOKIES_B64=...        # Optional but recommended in Actions to avoid YouTube blocking
DIGEST_TIMEZONE=America/New_York
NOTION_TOKEN=secret_...       # Optional: enables Notion publishing
NOTION_PAGE_ID=...            # Optional: parent page for digests
NOTION_ROOT_TITLE=...          # Optional: parent page title override
```
**No ANTHROPIC_API_KEY needed** — summarization runs through Gemini.

## Error Handling
- yt-dlp fails for a channel → log error, skip channel, continue
- Transcript unavailable → use video description, mark `[자막 없음]`
- Single channel failure must never crash the full pipeline

## Output Format
File: `output/YYYY-MM-DD.md`
- Header with date and stats
- One `### 📺 [channel](...)` section per channel
- One `## [video title](...)` section per video
- Each video follows `config/format.md`: `한 줄 인사이트` → short `핵심 요약` → 3-link `주요 타임라인`
