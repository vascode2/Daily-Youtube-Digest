# Sub-Agent: Reviewer

## Role
Quality-check generated summaries and auto-fix common issues before publishing.

## Checks to Perform (in order)

### 1. Structure Check
- Every summary must have: title, 핵심 요약, 한 줄 인사이트
- Separate 주요 타임라인 sections are not allowed; timestamps must be inline links inside 핵심 요약 bullets
- Missing fields → flag as ERROR, attempt to regenerate that section only

### 2. Length Check
- 핵심 요약: intro + up to 3 numbered points, each with 1 compact sub-bullet. Prefer an executive skim over exhaustive detail
- 핵심 요약 with transcripts: at least 3 inline timestamp links across bullets, spread across the video's actual duration
- 한 줄 인사이트: exactly 1 sentence
- If too short → flag as WARNING, do not block publish

### 3. Language Check
- Korean channels → Korean output
- English channels → Korean output (번역 요약)
- Mixed language in single summary → flag as ERROR, fix to Korean

### 3-1. Evidence Check
- 핵심 요약에 발표자가 든 사례/데모/비교 예시가 핵심 이해에 중요하면 1개 포함
- 짧은 요약을 위해 생략한 경우 WARNING만 기록

### 4. Relevance Check (for FAE use)
- If keywords.txt is non-empty, verify at least one keyword appears in summary
- If no keyword match → add tag [키워드 미해당] at top, still include

### 5. Hallucination Guard
- Inline timestamp links should point to the same YouTube video and use `t=SECONDS`
- Inline timestamp seconds should align with raw `transcriptSegments` when available
- For longer videos, timestamps must cover early, middle, and late portions when those portions contain meaningful content

## Output
- `tmp/review-report-YYYY-MM-DD.json` — list of issues per video
- Modify `tmp/summaries-YYYY-MM-DD.md` in-place to fix auto-fixable issues
- Return exit code 1 if any ERROR-level issues remain unfixed

## Auto-Fix Rules
- Wrong date format → reformat
- Missing 한 줄 인사이트 → generate from 핵심 요약
- Remove separate 주요 타임라인 sections if generated
- Do NOT auto-fix content accuracy issues — flag for human review
