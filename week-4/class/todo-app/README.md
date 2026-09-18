# 투두 앱

React 단일 파일 프런트엔드 + Node 서버 + Supabase(PostgreSQL) 저장.

## 실행

```bash
npm install          # pg 드라이버 설치
cp .env.example .env # DATABASE_URL 채우기
PORT=6003 node server.js   # http://localhost:6003 (기본 3000)
```

## 구성

| 파일 | 역할 |
| --- | --- |
| `server.js` | 정적 서빙 + todos REST API |
| `public/index.html` | React 18 + Tailwind CDN 단일 파일 UI |
| `.env` | `DATABASE_URL` (커밋 제외) |

## 기능

- 할 일 추가 / 완료 토글 / 제목 수정(클릭 → Enter 저장, Esc 취소) / 개별 삭제
- 전체 · 진행 중 · 완료 필터와 각 개수 표시
- 완료 항목 일괄 삭제, 남은 할 일 카운트
- 로딩 · 빈 상태 · 에러 배너 처리, 모바일 대응

## 데이터베이스

첫 요청 때 테이블이 없으면 자동 생성한다.

```sql
CREATE TABLE IF NOT EXISTS todos (
  id         BIGSERIAL PRIMARY KEY,
  title      TEXT        NOT NULL,
  done       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## API

| 메서드 | 경로 | 요청 body | 응답 |
| --- | --- | --- | --- |
| `GET` | `/api/todos` | – | `200 { success, data: [todo] }` |
| `POST` | `/api/todos` | `{ title }` | `201 { success, data: todo }` |
| `PATCH` | `/api/todos/:id` | `{ title? , done? }` | `200 { success, data: todo }` |
| `DELETE` | `/api/todos/:id` | – | `200 { success, message }` |
| `DELETE` | `/api/todos?done=true` | – | `200 { success, data: { deleted } }` |
| `GET` | `/api/health` | – | `200 { success, data: { status, db } }` |

`todo` = `{ id, title, done, createdAt }`. 검증 실패는 `400`, 없는 항목은 `404`, DB 장애는 `503`.
