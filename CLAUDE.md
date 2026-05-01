# Daily YouTube Digest — Project Guide

## Purpose
Automatically collect, summarize, and publish YouTube video summaries from watched channels every morning. **Claude Code itself does the summarization — no Anthropic API key required.**

## Tech Stack
- Runtime: Node.js v22+
- YouTube data: yt-dlp (CLI tool)
- AI summarization: **Claude Code (this CLI you're using)** — reads files, writes summaries directly
- Output: Markdown files + optional Notion API

## Workflow Overview
1. **Collect** (Node script) — yt-dlp fetches yesterday's videos + transcripts
2. **Summarize** (Claude Code) — Claude reads raw JSON, writes summaries following `config/format.md`
3. **Review** (Node script) — Validates structure and auto-fixes formatting
4. **Publish** (Node script) — Saves to `output/YYYY-MM-DD.md` and optionally Notion

## Trigger Phrase

When the user says **"어제 거 요약해 줘"**, **"run digest"**, or **"daily digest"**, execute this exact sequence:

### Step 1: Collect
```bash
npm run collect
```
This creates `tmp/raw-YYYY-MM-DD.json` with yesterday's videos.

### Step 2: Summarize (you do this — no API call)
1. Read `tmp/raw-YYYY-MM-DD.json`
2. Read `config/format.md` for the required output format
3. Read `agents/summarizer.md` for tone and audience guidance
4. For each video, write a summary in the exact format from `config/format.md`
5. Group summaries by channel under `## @channelhandle` headings
6. Write the result to `tmp/summaries-YYYY-MM-DD.md` with header `# YouTube Digest — YYYY-MM-DD`

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
NOTION_TOKEN=secret_...       # Optional: enables Notion publishing
NOTION_PAGE_ID=...            # Optional: parent page for digests
```
**No ANTHROPIC_API_KEY needed** — summarization runs through Claude Code.

## Error Handling
- yt-dlp fails for a channel → log error, skip channel, continue
- Transcript unavailable → use video description, mark `[자막 없음]`
- Single channel failure must never crash the full pipeline

## Output Format
File: `output/YYYY-MM-DD.md`
- Header with date and stats
- One `## @channel` section per channel
- One `### video title` per video
- Each video follows `config/format.md` structure exactly
