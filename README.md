# Daily YouTube Digest

> A small robot that watches your YouTube subscriptions overnight and leaves a clean summary in your Notion before you wake up.

![Example output in Notion](docs/example-output.png)

**📖 [See the visual explanation →](https://vascode2.github.io/Daily-Youtube-Digest/)**
*(One-page walkthrough with a flowchart — how it works, what you get, and why it's free.)*

---

## What this is, in plain English

You probably subscribe to a bunch of YouTube channels. Some upload daily. You don't have time to watch all of them. By the time you check, half the videos feel stale.

This project fixes that. Every morning at 7 AM:

1. A computer in the cloud (not yours) wakes up.
2. It checks each channel on your list for new videos uploaded yesterday.
3. It reads each video's transcript and writes a short structured summary, a one-line takeaway, and a three-point timeline.
4. It drops everything into a fresh page in your Notion.
5. You wake up, open Notion, and skim the digest. Two minutes, done.

You don't run anything. Your laptop can be off. Your phone can be in another country. It just works.

---

## What you actually see

A new Notion page every morning, looking roughly like this:

```
📺 YouTube Digest — 2026-05-02
Generated: 07:15 GMT-4 · Channels: 3 · Videos: 6 · Errors: 0

📺 AI Engineer  ← clickable channel link, name shown in red

   Building Conversational Agents with Gemini Live API   ← clickable
   💡 Real-time multimodal agents are getting cheap and fast.

   Key Summary
   Google DeepMind engineers walk through the new Live API for
   building a real-time voice assistant — WebSocket session setup,
   multimodal input, and tool calls during a live conversation.

   1. Live API setup
      - They open a WebSocket session and stream partial audio so the
        assistant can start responding before the full turn ends. [04:18]

   2. Tool calls during conversation
      - In the demo they swap a stock prompt for a tool-aware one and
        add a calendar tool call mid-turn.

   Main Timeline
   - [04:18] WebSocket session and partial audio streaming
   - [18:55] Calendar tool call added during the live turn
   - [24:10] Latency and deployment trade-offs
```

Every channel header, video title, and timeline timestamp is a clickable link. Channel headers are red so you can scan fast.

---

## The trick: it's free to run

Most "AI summary" tools charge you per summary because they use a paid API.

This system uses the **Gemini API** for summarization. The workflow tries `gemini-3-fast` first, then automatically falls back to available Gemini fast/flash models for reliable runs.

GitHub Actions (the cloud runner) is also free for public repos. Notion API is free.

---

## Three ways to use it

| Mode | When | How to start |
|------|------|--------------|
| **Daily auto-digest** | Yesterday's videos, every morning | Already on. Runs at 7 AM EDT. |
| **Weekly recap** | Last 7 days, on demand | Actions tab → `[MANUAL] Weekly YouTube Digest` → Run workflow |
| **Single channel catch-up** | Specific channel, last N videos | Actions tab → `[MANUAL] Channel YouTube Digest` → enter `@handle` and number |

---

## Setup (one-time, ~15 minutes)

You only do this once. After it's done, the daily run happens forever without you touching anything.

### 1. Required accounts (free)
- [GitHub](https://github.com) — hosts the code and runs the daily job
- [Notion](https://notion.so) — destination for digests
- Google AI Studio / Gemini API key — for summarization

### 2. Required tools (free, install once)
- [Node.js](https://nodejs.org) v22+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) (only needed if you want to test locally)

### 3. Fork or clone
```bash
git clone https://github.com/vascode2/Daily-Youtube-Digest.git
cd Daily-Youtube-Digest
npm install
```

### 4. List your channels
Edit [config/channels.txt](config/channels.txt) — one YouTube handle per line:
```
@MyFavoriteChannel
@AnotherChannel
```

### 5. Connect Notion
1. Go to https://www.notion.so/my-integrations → **+ Create new connection**
2. Name it `YouTube Digest`, type **Internal**, save → copy the secret (`ntn_…`)
3. In Notion, create a page named "YouTube Summary" (any name works)
4. On that page: **`···`** menu → **Connections** → add your `YouTube Digest` integration
5. Copy the page's URL — the 32-character ID at the end is your `NOTION_PAGE_ID`

### 6. Get a Gemini API key
Create a Gemini API key in Google AI Studio and keep it ready for GitHub Actions secrets.

### 7. Get YouTube cookies (so the cloud server isn't blocked)
1. Install the Chrome extension [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
2. Visit https://www.youtube.com (logged in)
3. Click the extension → **Export As** → **Netscape format** → save the file
4. Convert to base64 (PowerShell):
   ```powershell
   $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\youtube.com_cookies.txt"))
   Set-Clipboard -Value $b64
   ```
   *(or `base64 -w0 youtube.com_cookies.txt | pbcopy` on Mac/Linux)*

### 8. Add 4 secrets to GitHub
Go to https://github.com/YOUR_USERNAME/Daily-Youtube-Digest/settings/secrets/actions and add:

| Name | Value |
|------|-------|
| `GEMINI_API_KEY` | the Gemini API key from step 6 |
| `NOTION_TOKEN` | the `ntn_...` token from step 5 |
| `NOTION_PAGE_ID` | the 32-char page ID from step 5 |
| `YOUTUBE_COOKIES_B64` | the base64 cookies from step 7 |

### 9. Test it
Go to the **Actions** tab → `[AUTO] Daily YouTube Digest` → **Run workflow** → wait 5 minutes → check your Notion.

That's it. Tomorrow at 7 AM it runs by itself.

---

## Folder structure

```
.
├── docs/index.html             # Visual walkthrough (this is what github.io serves)
├── CLAUDE.md                   # Project guide for local agent workflows
├── agents/                     # Sub-agent role definitions (collect/summarize/review/publish)
├── config/
│   ├── channels.txt            # Your YouTube channel list
│   ├── format.md               # Output format spec
│   └── keywords.txt            # Optional keyword filter
├── scripts/
│   ├── collect.js              # Fetches videos with yt-dlp
│   ├── review.js               # Quality-checks summaries
│   └── publish.js              # Saves to Notion + repo
├── .github/workflows/
│   ├── daily-digest.yml        # 7 AM EDT auto-cron
│   ├── weekly-digest.yml       # On-demand weekly
│   └── channel-digest.yml      # On-demand single channel
└── output/                     # Generated digest archive (committed to repo)
```

---

## Customizing

| Want to change… | Edit this file |
|---|---|
| Which channels are watched | `config/channels.txt` |
| The output format/style | `config/format.md` |
| Tone, audience, language | `agents/summarizer.md` |
| When the daily runs | `cron:` line in `.github/workflows/daily-digest.yml` |
| Filter videos by keyword | uncomment lines in `config/keywords.txt` |
| Switch summarization model | `GEMINI_MODEL` / `GEMINI_MODEL_FALLBACKS` in workflow files or `.env` |

---

## Troubleshooting

**"No videos collected"** — yesterday simply had no uploads from your channels, OR your YouTube cookies expired. Refresh the cookies (step 7 above) every ~60 days.

**"Gemini API failed"** — check that `GEMINI_API_KEY` is set in GitHub Actions secrets. The summarizer logs which models it found and which fallback model it tried.

**Notion page not appearing** — check that the parent page is shared with your `YouTube Digest` integration (Connections menu). Then refresh Notion.

**Workflow shows red X but Notion has the page** — usually a temporary git push race. Re-running fixes it; the Notion publish already succeeded.

---

## License

MIT. Use it, fork it, modify it.

---

## Credits

- Original concept inspired by [@dekilab](https://www.youtube.com/@dekilab)'s Claude Code workflow tutorial
- Built with Gemini, [yt-dlp](https://github.com/yt-dlp/yt-dlp), and [Notion API](https://developers.notion.com)
