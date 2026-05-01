# Daily YouTube Digest

Automatically collects, summarizes, and publishes daily/weekly digests from your YouTube subscription channels — with **no Anthropic API key required** (Claude Code itself does the summarization). Runs 24/7 on GitHub Actions and publishes to Notion.

## Features

- 📺 Tracks N YouTube channels via [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- 🤖 Summarization powered by Claude Code (no API key, uses your subscription via OAuth)
- 📝 Notion integration: each digest becomes a child page under your designated parent
- ⏰ GitHub Actions cron: daily (08:30 KST) and weekly (Mon 09:00 KST) — runs even when your computer is off
- 🎨 Notion output: clickable video titles (h2), red channel headers, structured summaries
- 🔍 Optional keyword filtering

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                  GitHub Actions (cron)                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 1. yt-dlp collect (with YouTube cookies)             │  │
│  │ 2. Claude Code (--print mode, OAuth token)           │  │
│  │ 3. review.js (validate format)                       │  │
│  │ 4. publish.js (write output/, POST to Notion API)    │  │
│  │ 5. git commit & push output back to repo             │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

CLAUDE.md tells Claude Code which files to read, what format to follow, and which sub-agent guides to consult (`agents/collector.md`, `agents/summarizer.md`, etc.).

## Project Structure

```
.
├── CLAUDE.md                      # Entry point read by Claude Code
├── agents/                        # Sub-agent role definitions
│   ├── collector.md
│   ├── summarizer.md
│   ├── reviewer.md
│   └── publisher.md
├── config/
│   ├── channels.txt               # YouTube channels to monitor
│   ├── format.md                  # Output format spec
│   └── keywords.txt               # Optional keyword filter
├── scripts/
│   ├── collect.js                 # yt-dlp wrapper (Node)
│   ├── review.js                  # Quality check on summaries
│   └── publish.js                 # File output + Notion publish
├── .github/workflows/
│   ├── daily-digest.yml           # Cron: 23:30 UTC daily
│   └── weekly-digest.yml          # Cron: Mon 00:00 UTC
├── output/                        # Generated digest files (committed)
└── tests/test-pipeline.js
```

## Local Setup (optional, for development)

Requirements:
- Node.js v22+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) on PATH
- [Claude Code CLI](https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview)

```bash
git clone https://github.com/vascode2/Daily-Youtube-Digest.git
cd Daily-Youtube-Digest
npm install
npm test                        # validate setup
```

Then edit [config/channels.txt](config/channels.txt) and run Claude Code:
```bash
claude
```
Inside Claude Code:
```
어제 거 요약해 줘            # daily
지난 일주일 요약해 줘         # weekly
```

For Notion publishing locally, create `.env`:
```
NOTION_TOKEN=ntn_...
NOTION_PAGE_ID=...
```

## GitHub Actions Setup (24/7 automation)

The workflows run on schedule even when your computer is off. Three secrets must be configured in [Settings → Secrets and variables → Actions](https://github.com/vascode2/Daily-Youtube-Digest/settings/secrets/actions):

| Secret | How to get it |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token` locally, copy the `sk-ant-oat01-...` token from the terminal |
| `NOTION_TOKEN` | Create an [Internal Integration](https://www.notion.so/my-integrations) and copy its secret (`ntn_...`). Share the parent page with the integration. |
| `NOTION_PAGE_ID` | Open the parent Notion page → copy its 32-char ID from the URL |
| `YOUTUBE_COOKIES_B64` | See "YouTube Cookies" below |

### YouTube Cookies (required for cloud runners)

YouTube increasingly blocks anonymous access from cloud IPs. To work around this, export cookies from your browser and store them as a base64-encoded GitHub Secret.

1. Install the [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) Chrome extension
2. Visit https://www.youtube.com (logged in)
3. Click the extension → Export As → **Netscape format** → save `youtube.com_cookies.txt`
4. Base64-encode the file:

   PowerShell:
   ```powershell
   $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\youtube.com_cookies.txt"))
   Set-Clipboard -Value $b64
   ```
   Bash/macOS:
   ```bash
   base64 -w0 ~/Downloads/youtube.com_cookies.txt | pbcopy
   ```
5. Add as GitHub Secret `YOUTUBE_COOKIES_B64`

⚠️ Cookies expire (typically 30–90 days). When jobs start failing, repeat steps 2–5 to refresh.

### Triggering Manually

Go to the [Actions tab](https://github.com/vascode2/Daily-Youtube-Digest/actions) → select a workflow → **Run workflow**.

## Output Format

Each video produces:
```markdown
## [Video Title](https://www.youtube.com/watch?v=VIDEO_ID)

**핵심 요약**
> 2-4 sentence summary

**주요 타임라인** (only if transcript present)
- [HH:MM:SS] timestamp content

**한 줄 인사이트**
💡 One-sentence takeaway
```

Channels are grouped under red `### 📺 ChannelName` headers in Notion.

## Customization

- **Add channels**: edit `config/channels.txt` (one `@handle` per line)
- **Filter by keywords**: uncomment lines in `config/keywords.txt`
- **Change format**: edit `config/format.md` — Claude Code follows this exactly
- **Change tone/audience**: edit `agents/summarizer.md`
- **Change schedule**: edit `cron:` lines in `.github/workflows/*.yml` ([crontab.guru](https://crontab.guru))

## Notes on Privacy & Cost

- Workflow runs on **public** GitHub repos are free (unlimited minutes)
- The `output/` folder is committed to the repo — anyone with repo access can see your digest content
- No video content is stored, only your written summaries
- Cookies and Notion tokens stay encrypted in GitHub Secrets, never in code

## License

MIT
