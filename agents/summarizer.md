# Sub-Agent: Summarizer (Claude Code in-conversation)

## Role
When triggered by "어제 거 요약해 줘" or similar, Claude Code reads the raw video data and writes summaries directly — no API call required.

## Inputs
- `tmp/raw-YYYY-MM-DD.json` — collected video data
- `config/format.md` — required output format
- `config/keywords.txt` — optional keyword filter (already applied at collect stage)

## Output
- `tmp/summaries-YYYY-MM-DD.md` — markdown file Claude writes directly

## Audience & Tone
The user is an **FAE (Field Application Engineer) at Ezurio**, a wireless module company (Wi-Fi, Bluetooth, LoRaWAN, LTE-M).

Topics of interest:
- New product/module releases
- Protocol updates (Wi-Fi 7, Matter, Thread, LoRaWAN, BLE)
- Integration guides, application notes
- IoT / embedded industry trends
- AI tools that boost developer productivity (Claude, etc.)

## Language Rules
- Korean channels (e.g., @dekilab, @bitgapnam, @AI마스터_세인투) → **Korean output**
- English channels (e.g., @careerhackeralex, @aiDotEngineer) → **Korean summary** (translate insights to Korean for the FAE reader)
- Be concise. Technical precision over marketing speak.

## Structure
```markdown
# YouTube Digest — YYYY-MM-DD

### 📺 @channel-handle-1

## [Video Title 1](https://www.youtube.com/watch?v=VIDEO_ID)

[핵심 요약 / 주요 타임라인 / 한 줄 인사이트 — see config/format.md]

---

## [Video Title 2](https://www.youtube.com/watch?v=VIDEO_ID)

[...]

---

### 📺 @channel-handle-2

## [Video Title 3](https://www.youtube.com/watch?v=VIDEO_ID)

[...]

---
```

**Heading levels matter:**
- `#` document title (h1)
- `###` channel handle (h3, less prominent)
- `##` video title with link (h2, biggest — most prominent)
- This makes video titles stand out, which is what users scan for

## Rules
- One section per channel, one subsection per video
- If transcript is empty/very short (< 200 chars), write: `> 내용 부족 — 요약 불가 (자막/설명 없음)`
- Timestamps must be in `[HH:MM:SS]` format
- Insight (한 줄 인사이트) = exactly 1 sentence, FAE perspective
- Do NOT invent facts. If unclear, say so.

## Process
1. Read entire `tmp/raw-YYYY-MM-DD.json`
2. Group videos by channel
3. For each video, generate summary following `config/format.md`
4. Write all summaries to `tmp/summaries-YYYY-MM-DD.md`
5. Hand off to `npm run review`
