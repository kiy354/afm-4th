# 밸런스 게임

질문을 등록하고 둘 중 하나에 투표하는 앱.
React 단일 파일 프런트엔드 + Node 서버 + Supabase(PostgreSQL) 저장.

## 실행

```bash
npm install          # pg 드라이버 설치
cp .env.example .env # DATABASE_URL 채우기
PORT=6006 node server.js   # http://localhost:6006 (기본 3000)
```

## 구성

| 파일 | 역할 |
| --- | --- |
| `server.js` | 정적 서빙 + 질문/투표 REST API |
| `public/index.html` | React 18 + Tailwind CDN 단일 파일 UI |
| `api/[...path].js` | Vercel 서버리스 진입점 (server.js 재사용) |
| `.env` | 로컬용 `DATABASE_URL` (커밋·배포 제외) |
| `.vercelignore` | `.env` 를 배포 번들에서 제외 |

## 비밀값(DB 비밀번호) 관리

접속 정보는 **서버에만** 두고 환경변수로만 주입한다. 브라우저로는 절대 내려가지 않는다.

| 위치 | 저장 방법 |
| --- | --- |
| 로컬 | `.env` 의 `DATABASE_URL` — `.gitignore`(`.env*`)와 `.vercelignore` 로 커밋·업로드에서 제외 |
| 배포(Vercel) | 프로젝트 환경변수 `DATABASE_URL` (Production / Preview / Development) — `vercel env add DATABASE_URL production` |

지켜야 할 규칙:

- `public/` 아래 파일(브라우저가 받는 코드)에는 비밀값을 절대 쓰지 않는다. 화면은 `/api/*` 만 호출하고,
  DB 접속은 전부 `server.js` 안에서 일어난다.
- `DATABASE_URL` 은 `server.js` 의 `databaseUrl()` 한 곳에서만 읽는다. 값이 없으면 서버 로그에만
  원인을 남기고 클라이언트에는 `서버 설정이 완료되지 않았습니다.` 만 돌려준다.
- DB 오류 원문(호스트·계정명이 들어 있을 수 있다)은 응답에 싣지 않는다. `/api/health` 는 성공이면
  `db: "connected"`, 실패면 `db: "disconnected"` 만 알려 준다.
- 비밀번호가 바뀌면 `.env` 와 Vercel 환경변수를 모두 갱신하고 다시 배포한다
  (`vercel env rm DATABASE_URL production` → `vercel env add …` → `vercel deploy --prod`).

## 기능

- 밸런스 질문 등록 (제목은 선택, 두 선택지는 필수·서로 달라야 함)
- 둘 중 하나에 투표 → 막대와 퍼센트가 즉시 움직임
- 4초마다 목록을 다시 읽어 **다른 사람이 던진 표도 실시간 반영** (탭이 숨겨져 있으면 쉬고, 돌아오면 바로 갱신)
- 질문별 득표율·득표 수·참여 인원, 상단에 **총 참여자 수**·누적 투표 수·질문 수
- 선택 변경(다른 쪽 클릭)과 투표 취소
- 로딩 · 빈 상태 · 에러 배너 처리, 모바일 대응

### 한 사람 한 표

브라우저가 처음 접속할 때 `crypto.randomUUID()` 로 만든 `voterId` 를 localStorage 에
저장하고, 모든 요청에 `x-voter-id` 헤더로 보낸다. DB 의 `(question_id, voter_id)`
유니크 제약 덕분에 한 질문당 한 표만 남고, 다시 투표하면 표가 늘지 않고 선택만 바뀐다.
(로그인이 없으므로 브라우저를 바꾸면 다른 사람으로 센다.)

## 데이터베이스

첫 요청 때 테이블이 없으면 자동 생성한다.

```sql
CREATE TABLE IF NOT EXISTS balance_questions (
  id         BIGSERIAL PRIMARY KEY,
  title      TEXT        NOT NULL DEFAULT '',
  option_a   TEXT        NOT NULL,
  option_b   TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS balance_votes (
  id          BIGSERIAL PRIMARY KEY,
  question_id BIGINT      NOT NULL REFERENCES balance_questions(id) ON DELETE CASCADE,
  voter_id    TEXT        NOT NULL,
  choice      TEXT        NOT NULL CHECK (choice IN ('A', 'B')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (question_id, voter_id)
);
```

퍼센트는 저장하지 않고 조회할 때마다 표를 세서 계산한다(집계는 SQL, 반올림은 화면).

## API

모든 요청에 `x-voter-id` 헤더를 함께 보낸다(투표는 필수, 조회는 "내 선택" 표시용).

| 메서드 | 경로 | 요청 body | 응답 |
| --- | --- | --- | --- |
| `GET` | `/api/questions` | – | `200 { success, data: { questions, stats } }` |
| `POST` | `/api/questions` | `{ title?, optionA, optionB }` | `201 { success, data: { question, stats } }` |
| `POST` | `/api/questions/:id/vote` | `{ choice: "A" \| "B" }` | `200 { success, data: { question, stats } }` |
| `DELETE` | `/api/questions/:id/vote` | – | `200 { success, data: { question, stats } }` |
| `GET` | `/api/health` | – | `200 { success, data: { status, db } }` |

`question` = `{ id, title, optionA, optionB, createdAt, votesA, votesB, totalVotes, myChoice }`
`stats` = `{ questionCount, voteCount, participantCount }` (participantCount = 중복 없는 투표자 수)

제목·선택지는 각각 100자까지. 검증 실패는 `400`, 없는 질문·취소할 표 없음은 `404`,
DB 장애는 `503`.
