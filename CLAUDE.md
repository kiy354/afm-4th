# afm-4th — 저장소 공통 규칙

AFM 4기 학습 저장소입니다. 주차별 수업·과제 결과물을 누적합니다.

## 소통

- **한국어로 답변합니다.** 커밋 메시지·README·주석도 한국어로 씁니다.
- 학습용 저장소이므로 결과물뿐 아니라 **왜 그렇게 했는지**를 남깁니다.
  각 앱 README의 "구현하면서 해결한 문제" 섹션이 그 예시입니다.
- 환경은 Windows 11 + PowerShell입니다. 명령 예시는 이 환경 기준으로 제시합니다.

## 디렉터리 규칙

```
week-N/
├── class/    # 수업 중 따라한 것
└── quest/    # 과제
```

앱이 여러 개인 주차(week-4)는 `week-4/balance-game/`처럼 앱 이름으로 형제 폴더를 둡니다.

## 앱 구조 관례

대부분의 앱이 같은 형태를 따릅니다.

- 프론트엔드: 빌드 도구 없는 **단일 `index.html`** (CDN React 18 · Babel Standalone · Tailwind)
- 백엔드: **단일 `server.js`** (Express 5)
- DB: Supabase PostgreSQL (`pg` 드라이버, Transaction Pooler 6543)
- 배포: Vercel — `vercel.json`에서 `/api/*` → `server.js`, 나머지 → `index.html`

**DB 테이블에는 앱별 접두사를 붙입니다** (예: `fridge_ingredients`).
여러 과제가 Supabase 한 곳을 공유하기 때문에 이름 충돌을 막으려는 것입니다.

## 비밀값 취급

- API 키·DB 연결 문자열은 **코드나 `CLAUDE.md`에 절대 쓰지 않습니다.** `.env`에 두고
  `.env.example`에는 자리표시자만 남깁니다.
- 배포 시에는 `npx vercel env add <NAME> production`으로 등록하고,
  키를 바꾸면 로컬 `.env`와 Vercel 환경변수를 **양쪽 다** 갱신합니다.

## 에이전트 메모리

- 저장소에 공유할 맥락 → `docs/agent-memory/` (이 파일에서 링크)
- 개인용·기기별 메모리 → `~/.claude/projects/<프로젝트>/memory/` (git 제외)

`.gitignore`가 `.claude/` 전체를 제외하므로, 공유할 규칙을 `.claude/` 안에 두면 커밋되지 않습니다.

| 문서 | 내용 |
|---|---|
| [docs/agent-memory/weekly-log.md](docs/agent-memory/weekly-log.md) | 주차별로 무엇을 만들었는지 |
| [docs/agent-memory/app-conventions.md](docs/agent-memory/app-conventions.md) | 앱 구현 시 반복해서 쓰는 패턴과 함정 |

## 디렉터리별 규칙

일부 폴더에는 그 폴더에만 적용되는 `CLAUDE.md`가 따로 있습니다.

- `week-4/pokemon-company/` — 답변 말투 지정
