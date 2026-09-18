# 메모 앱

React 단일 파일 프런트엔드 + Node 서버 + Supabase(PostgreSQL) 저장.

## 실행

```bash
npm install          # pg 드라이버 설치
cp .env.example .env # DATABASE_URL 채우기
PORT=6004 node server.js   # http://localhost:6004 (기본 3000)
```

## 구성

| 파일 | 역할 |
| --- | --- |
| `server.js` | 정적 서빙 + memos REST API |
| `public/index.html` | React 18 + Tailwind CDN 단일 파일 UI |
| `api/[...path].js` | Vercel 서버리스 진입점 (server.js 재사용) |
| `.env` | `DATABASE_URL` (커밋 제외) |

## 기능

- 메모 작성 / 목록 조회 / 상세 보기 / 수정 / 삭제
- 제목·내용 검색 (목록이 작아 클라이언트에서 즉시 필터링)
- 삭제 전 확인 창, 카드 클릭 시 전체 내용 모달
- 로딩 · 빈 상태 · 에러 배너 처리, 모바일 대응

## 데이터베이스

첫 요청 때 테이블이 없으면 자동 생성한다.

```sql
CREATE TABLE IF NOT EXISTS memos (
  id         BIGSERIAL PRIMARY KEY,
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## API

| 메서드 | 경로 | 요청 body | 응답 |
| --- | --- | --- | --- |
| `GET` | `/api/memos` | – | `200 { success, data: [memo] }` |
| `GET` | `/api/memos?q=검색어` | – | `200 { success, data: [memo] }` |
| `GET` | `/api/memos/:id` | – | `200 { success, data: memo }` |
| `POST` | `/api/memos` | `{ title, content? }` | `201 { success, data: memo }` |
| `PATCH` | `/api/memos/:id` | `{ title? , content? }` | `200 { success, data: memo }` |
| `DELETE` | `/api/memos/:id` | – | `200 { success, message }` |
| `GET` | `/api/health` | – | `200 { success, data: { status, db } }` |

`memo` = `{ id, title, content, createdAt }`. 제목은 200자, 내용은 10,000자까지.
검증 실패는 `400`, 없는 항목은 `404`, DB 장애는 `503`.
