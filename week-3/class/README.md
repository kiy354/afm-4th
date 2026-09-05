# Week 3 · Class — Playwright MCP 브라우저 자동화 실습

2026-09-05, Claude Code + Playwright MCP(Chromium)로 실제 서비스 7곳을 직접 열고 · 조작하고 · 캡처한 기록입니다.

## 폴더 구성

| 폴더 | 내용 |
|------|------|
| [site/](site/) | `index.html` — 챌린지 7개를 탐색하는 단일 파일 웹사이트 (React 18 + Tailwind, CDN) |
| [docs/](docs/) | [Playwright-MCP-챌린지-리서치.md](docs/Playwright-MCP-챌린지-리서치.md) — 리서치 원본 문서 |
| [screenshots/](screenshots/) | 실습 중 캡처한 스크린샷 11장 |
| [logs/](logs/) | Playwright 콘솔 로그 · 접근성 스냅샷 원본 |

> 브라우저 콘솔 로그·접근성 스냅샷 원본은 [logs/](logs/) 에 있습니다.

## 웹사이트 실행

`file://` 로 직접 열면 브라우저 보안 정책에 걸릴 수 있으니 로컬 서버로 여세요.

```bash
# 이 폴더(week-3/class)를 루트로 서빙
npx serve .
# → http://localhost:3000/site/index.html

# 또는 VS Code Live Server 확장에서 site/index.html 우클릭 → Open with Live Server
```

**라우트** (해시 라우팅)

- `/#/` — 개요: 통계 · 요약 표 · 챌린지 카드 그리드
- `/#/challenge/:id` — 챌린지 상세 (`naver-weather`, `google-form`, `naver-cafe`, `fleamarket`, `coupang`, `instagram`, `youtube`)
- `/#/lessons` — 배운 점 6가지

## 챌린지 7개 요약

| # | 챌린지 | 결과 |
|---|--------|------|
| 1 | 네이버 날씨 검색 & 캡처 | ✅ 성공 |
| 2 | 구글폼 자동 작성 & 제출 | ✅ 성공 |
| 3 | 네이버 카페 비로그인 → 로그인 | ✅ 성공 |
| 4 | 플리마켓 검색 + 낮은 가격순 정렬 | ✅ 성공 |
| 5 | 쿠팡 회원가입 화면 → 홈 | ⚠️ 제약 확인 |
| 6 | 인스타그램 | ⚠️ 로그인 벽 |
| 7 | 유튜브 홈 | ⚠️ 비로그인 피드 없음 |

자세한 단계·관찰 내용은 [리서치 문서](docs/Playwright-MCP-챌린지-리서치.md) 또는 웹사이트에서 확인하세요.
