# 포켓몬 컴퍼니 홈페이지

회사 소개 페이지 + 하단 문의 폼. 접수된 문의는 **Supabase(PostgreSQL)** 의 `inquiries` 테이블에 저장된다.

## 실행

```bash
npm install          # pg 드라이버 설치
cp .env.example .env # DATABASE_URL 채우기
node server.js       # http://localhost:3000  (PORT 로 변경 가능)
```

## 구성

| 파일 | 역할 |
| --- | --- |
| `server.js` | 정적 서빙 + 문의 API. 문의를 Supabase `inquiries` 테이블에 insert |
| `public/index.html` | React 18 + Tailwind CDN 단일 파일 페이지 |
| `public/sprites/` | 파트너 포켓몬 이미지 |
| `.env` | `DATABASE_URL` (커밋 제외) |

## 데이터베이스

첫 요청 때 테이블이 없으면 자동 생성한다.

```sql
CREATE TABLE IF NOT EXISTS inquiries (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  email      TEXT        NOT NULL,
  company    TEXT,
  type       TEXT        NOT NULL,
  message    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Supabase 트랜잭션 풀러(6543 포트)를 쓰므로 커넥션은 최대 5개만 유지하고, SSL 과 연결 문자열 `.trim()` 을 적용한다.

## API

| 메서드 | 경로 | 요청 body | 응답 |
| --- | --- | --- | --- |
| `POST` | `/api/inquiries` | `{ name, email, company?, type, message }` | `201 { success, data: { id, receivedAt, savedTo } }` |
| `GET` | `/api/inquiries` | – | `200 { success, data: { count, storage } }` |
| `GET` | `/api/health` | – | `200 { success, data: { status, db } }` / DB 장애 시 `503` |

검증 실패는 `400 { success: false, message, errors }`, DB 장애는 `503` 으로 응답한다.

## 참고

- 페이지의 회사 정보·연혁·수치는 학습용 가상 데이터다.
- 문의를 `data/inquiries.txt` 에 쌓던 이전 버전은 DB 저장으로 교체됐다.
