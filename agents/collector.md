# Sub-Agent: Collector

## Role
Fetch yesterday's YouTube video metadata and transcripts using yt-dlp.

## Inputs
- `config/channels.txt` — channel handle list
- Target date: yesterday (UTC)

## yt-dlp Commands
```bash
# Get video list for a channel uploaded yesterday
yt-dlp --flat-playlist --dump-json "https://www.youtube.com/@HANDLE/videos" \
  --match-filter "upload_date >= YYYYMMDD" \
  --dateafter yesterday --datebefore today
```

## Transcript Strategy
The playlist `--dump-json` metadata already contains the original spoken
`language` plus direct caption URLs (`subtitles` = manual, `automatic_captions`
= auto) for the YouTube timedtext API. The collector fetches those URLs
directly instead of issuing a second yt-dlp call per video.

Why: a separate per-video yt-dlp subtitle call is the main trigger for HTTP 429
("Too Many Requests"), which previously left transcripts empty and produced
`[자막 기반 타임라인 없음]` in the summaries.

Preference order when picking a caption track:
1. Original spoken language first (so the transcript is a real transcription,
   not a machine-translation), then English, then Korean.
2. Manual subtitles beat auto-generated captions within a language.

Direct fetches use retry + backoff to ride out transient 429/5xx responses.
If every direct URL fails, the collector falls back to letting yt-dlp resolve
and download the subtitles itself (`--write-subs --write-auto-subs`, original
language first, with retries).

## Output
Save to `tmp/raw-YYYY-MM-DD.json`:
```json
[
  {
    "channel": "@handle",
    "videoId": "abc123",
    "title": "Video Title",
    "views": 12345,
    "uploadDate": "2025-04-30",
    "transcript": "full transcript text...",
    "description": "video description",
    "duration": 1234,
    "hasTranscript": true
  }
]
```

## Rules
- Skip channels with 0 videos yesterday (no error)
- If transcript missing: set hasTranscript=false, use description field
- If channel fetch fails: log to stderr, continue to next channel
- Filter by config/keywords.txt if file exists and is non-empty
