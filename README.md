# Daily YouTube Digest

매일 아침 구독 채널의 어제 업로드 영상을 자동으로 수집·요약·발행하는 Claude Code 워크플로우.

**Anthropic API 키가 필요 없습니다** — Claude Code 자체가 요약을 수행합니다.

## Requirements

- [Node.js](https://nodejs.org) v22+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) (PATH에 등록)
- [Claude Code](https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview) CLI

## Setup

```bash
git clone https://github.com/vascode2/Daily-Youtube-Digest.git
cd Daily-Youtube-Digest
npm install
npm test          # 환경 검증
```

`config/channels.txt`에 모니터링할 YouTube 채널 핸들 추가.

## Usage

Claude Code 터미널에서:
```
어제 거 요약해 줘
```

Claude Code가 [CLAUDE.md](CLAUDE.md)를 따라 자동으로:
1. `npm run collect` 실행 (yt-dlp로 어제 영상 수집)
2. raw 데이터를 읽고 요약 작성 (`tmp/summaries-YYYY-MM-DD.md`)
3. `npm run review` 실행 (품질 검증)
4. `npm run publish` 실행 (`output/YYYY-MM-DD.md` 저장)

## Project Structure

```
.
├── CLAUDE.md           # Claude Code 진입점
├── agents/             # Sub-agent 지침
├── config/             # 채널/포맷/키워드 설정
├── scripts/            # collect / review / publish (Node)
├── output/             # 최종 결과물 (날짜별 .md)
└── tests/
```

## Optional: Notion Publishing

`.env`에 `NOTION_TOKEN`, `NOTION_PAGE_ID` 설정 시 자동으로 Notion 페이지에도 발행됩니다.

## Optional: Daily Schedule

Claude Desktop → Routines → Local Routine 생성:
- Prompt: `"어제 거 요약해 줘"`
- Time: 매일 08:30
