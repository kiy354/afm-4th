# AGENTS.md — afm-4th

AI 코딩 에이전트(Claude Code, Codex, Cursor, Gemini CLI 등)가 이 저장소에서 작업할 때 따르는 규칙입니다.
사람용 소개는 각 앱의 `README.md`를 보세요.

## 저장소 개요

AFM 4기 학습 저장소입니다. 주차별 수업·과제 결과물을 누적합니다.
학습용이므로 결과물뿐 아니라 **왜 그렇게 했는지**를 남기는 것이 중요합니다.

- 주차별로 무엇을 만들었는지: [docs/agent-memory/weekly-log.md](docs/agent-memory/weekly-log.md)
- 앱 구현 패턴과 반복되는 함정: [docs/agent-memory/app-conventions.md](docs/agent-memory/app-conventions.md)

새 앱을 만들거나 기존 앱을 고치기 전에 `app-conventions.md`를 먼저 읽으세요.

## 소통·작성 언어

- 답변, 커밋 메시지, README, 코드 주석은 모두 **한국어**로 씁니다.
- 작업 환경은 **Windows 11 + PowerShell**입니다. 명령 예시는 PowerShell 기준으로 제시합니다
  (`&&` 대신 `;`, `rm -rf` 대신 `Remove-Item -Recurse -Force` 등).

## 디렉터리 구조

```
week-N/
├── class/    # 수업 중 따라한 것
└── quest/    # 과제
docs/agent-memory/   # 에이전트가 공유하는 맥락 문서 (커밋됨)
skills/              # 참고용 스킬 모음
```

- 앱이 여러 개인 주차는 `week-4/balance-game/`처럼 **앱 이름으로 형제 폴더**를 둡니다.
- 일부 폴더에는 그 폴더 전용 `CLAUDE.md`가 있습니다. 해당 폴더에서 작업할 때는 그 규칙도 따릅니다.
  - `week-1/quest/` — 비밀값을 파일에 다시 쓰지 말 것
  - `week-4/pokemon-company/` — 답변 말투 지정

## 앱 구조 관례

대부분의 앱이 같은 형태입니다. 새 앱도 특별한 이유가 없으면 이 형태를 따릅니다.

| 영역 | 구성 |
|---|---|
| 프론트엔드 | 빌드 도구 없는 **단일 `index.html`** — CDN React 18 · Babel Standalone · Tailwind |
| 백엔드 | **단일 `server.js`** — Express 5 |
| DB | Supabase PostgreSQL — `pg` 드라이버, Transaction Pooler(포트 6543) |
| 배포 | Vercel — `vercel.json`에서 `/api/*` → `server.js`, 나머지 → `index.html` |

앱 폴더 하나에 보통 `index.html`, `server.js`, `package.json`, `vercel.json`, `.env.example`, `README.md`가 있습니다.

### 로컬 실행

```powershell
cd week-5\snack-shop
npm install
Copy-Item .env.example .env   # 이후 .env에 실제 값 입력
npm start                     # node server.js
```

### 꼭 지킬 것

- **DB 테이블에 앱별 접두사**를 붙입니다 (예: `fridge_ingredients`, `snack_orders`).
  여러 과제가 Supabase 한 곳을 공유하므로 이름 충돌을 막기 위해서입니다.
- API 응답 형태를 통일합니다: `{ success: true, data }` / `{ success: false, message }`.
- 외부 API 키는 **서버에만** 둡니다. 브라우저는 자기 서버의 `/api`만 호출합니다.
- 클라이언트가 보낸 가격·작성자 등은 믿지 않고 **서버가 DB 값으로 다시 확인**합니다.

자세한 이유와 그 밖의 함정(DATE 컬럼 하루 밀림, Express 라우트 순서, 서버리스 초기화 등)은
[app-conventions.md](docs/agent-memory/app-conventions.md)에 있습니다.

## 비밀값 취급

- API 키·DB 연결 문자열·`JWT_SECRET`은 **코드, README, `AGENTS.md`, `CLAUDE.md`에 절대 쓰지 않습니다.**
- 실제 값은 `.env`에 두고, `.env.example`에는 **자리표시자만** 남깁니다. `.env`는 `.gitignore`로 제외됩니다.
- 배포 시에는 `npx vercel env add <NAME> production`으로 등록합니다.
  키를 바꾸면 로컬 `.env`와 Vercel 환경변수를 **양쪽 다** 갱신합니다.

## 문서화

- 각 앱 `README.md`에 **"구현하면서 해결한 문제"** 섹션을 두고, 막혔던 점과 해결 방법·이유를 적습니다.
- 새 주차 작업을 마치면 [weekly-log.md](docs/agent-memory/weekly-log.md)에 한 줄 추가합니다.
- 여러 앱에 반복해서 쓸 만한 패턴이나 함정을 발견하면 [app-conventions.md](docs/agent-memory/app-conventions.md)에 추가합니다.

## Git

- 기본 브랜치는 `master`입니다.
- 커밋 메시지는 한국어, `week-N: 무엇을 했는지` 또는 `week-N/quest: …` 형식입니다.
  예) `week-5: 과자 쇼핑몰 앱 추가 (장바구니·주문, 트랜잭션 재고 차감)`
- 커밋하지 않는 것: `.env`, `node_modules/`, `.vercel/`, `.claude/`, `.playwright-mcp/`, 다운로드한 영상·음성 파일.
- **`.claude/`는 통째로 git에서 제외됩니다.** 다른 사람·다른 기기와 공유할 규칙은
  `.claude/` 안이 아니라 이 파일이나 `docs/agent-memory/`에 둡니다.
