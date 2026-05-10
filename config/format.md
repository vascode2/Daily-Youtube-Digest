# 요약 출력 포맷

## 채널 헤더
각 채널 섹션은 h3 헤딩 + 📺 + **채널명(핸들 아님)** + **YouTube 채널 링크**:

```markdown
### 📺 [채널명](https://www.youtube.com/@CHANNEL_HANDLE)
```

예시:
- `### 📺 [AI Engineer](https://www.youtube.com/@aiDotEngineer)`
- `### 📺 [안될공학 - IT 테크 신기술](https://www.youtube.com/@unrealtech)`
- `### 📺 [데키랩](https://www.youtube.com/@dekilab)`

채널명과 핸들은 raw 데이터에서 사용. publish 단계에서 채널명이 빨간색으로 렌더링됨 (Notion `color: red`).

## 영상별 요약 포맷

각 영상 요약은 아래 형식을 정확히 따라야 합니다.

---

## [영상 제목](https://www.youtube.com/watch?v=VIDEO_ID)

**한 줄 인사이트**
💡 FAE 관점에서 이 영상이 업무에 주는 시사점 한 문장.

**핵심 요약** (2-3문단, 문단당 2-3문장)
영상의 핵심 개념을 엔지니어 관점에서 설명합니다.

두 번째 문단부터는 발표자가 사용한 사례/데모/비교 실험을 반드시 포함합니다.

영어 채널도 반드시 한국어로 작성합니다.

**주요 타임라인**
- [HH:MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS) 내용 1
- [HH:MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS) 내용 2
- [HH:MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS) 내용 3

자막 세그먼트(`transcriptSegments`)가 있을 때만 작성합니다.
타임라인 문구는 실제 세그먼트 내용을 요약해 작성하고, 임의 시간 생성 금지.

---

## 규칙
- 영상 제목은 **반드시 h2 헤딩 + YouTube 링크** 형식 (`## [제목](https://www.youtube.com/watch?v=VIDEO_ID)`)
- 조회수, 길이, 자막 유무, **업로드 날짜**는 출력에 포함하지 않음
- 날짜 정보는 페이지 제목(예: "Weekly Digest 2026-04-24 ~ 2026-04-30")에 이미 포함되어 있어 영상별 날짜는 불필요
- 섹션 순서: **한 줄 인사이트** → **핵심 요약** → **주요 타임라인**
- 핵심 요약은 단일 문단으로 끝내지 않음 (최소 2문단, 블록인용 제거)
- 핵심 요약에는 발표자가 든 예시/사례/데모를 1개 이상 포함
- 타임라인 timestamps는 반드시 YouTube 링크 형태로: `[HH:MM:SS](https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDS)`
