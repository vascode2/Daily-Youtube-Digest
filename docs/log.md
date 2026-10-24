# Daily YouTube Digest — Log

Format: dated entries, `- Did:` / `- Decision: … (reason: …)` / `- Assessment:`.

## 2026-10-24 — Author record started

- Did: wrote `docs/why.md` and `docs/log.md` and recorded the motivation directly.
- Decision: read the summary first and watch only the interesting videos (reason: far more videos to watch than time to watch them).
- Decision: pick channels once, scrape daily, and deliver to Notion (reason: the digest lands in my own notes and is easy to read).
- Decision: run it on GitHub Actions rather than locally (reason: everything happens in the cloud, no computer or local drive has to be on).
- Decision: start with Gemini, then try other models (reason: Gemini was free and worked well, but other models should be compared).
- Assessment: the pipeline works, but the habit does not yet. English study and the digest are the morning routine; when I sleep late I skip it, and that is mine to fix.
- Note (verified 2026-10-24): the workflows summarize with Gemini `gemini-3.5-flash` and a fallback chain; on 2026-05-10 they were switched to Claude Sonnet and back to Gemini the same day.
