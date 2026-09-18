# 라이카 스튜디오

한 줄짜리 장면 설명을 라이카로 찍은 듯한 사진으로 만들어 주는 앱. fal.ai(Flux) 를 쓰고,
**API 키는 서버 환경변수에만 두고 브라우저로는 내려보내지 않는다.**

## 실행

```bash
cp .env.example .env       # FAL_KEY 채우기
PORT=6004 node server.js   # http://localhost:6004 (기본 3000)
```

의존성 설치가 필요 없다 (Node 내장 모듈만 사용).

## 구성

| 파일 | 역할 |
| --- | --- |
| `server.js` | 정적 서빙 + fal.ai 프록시. 키는 여기서만 사용 |
| `public/index.html` | React 18 + Tailwind CDN 단일 파일 UI |
| `.env` | `FAL_KEY` (커밋 제외) |

## 키 분리 구조

```
브라우저 ──POST /api/generate──▶ server.js ──Key FAL_KEY──▶ fal.run
         ◀──── 이미지 URL ─────           ◀──────────────
```

- 클라이언트 코드에는 키도, `fal.run` 주소도 없다
- 프롬프트 접미사·모델·화면비는 서버가 정의하고, 클라이언트는 **id 만** 보낸다
  (임의 모델 호출이나 프롬프트 주입 방지)
- fal.ai 인증 실패(401/403)는 로그에만 남기고 사용자에게는 일반 메시지로 응답

## 기능

- 룩 프리셋 6종 — 클래식 컬러(Portra 400) · 모노크롬(Tri-X) · 야간 스냅(Noctilux) · 거리 스냅(Q2) · 인물(APO-Summicron) · 여행 필름(Ektar)
- 화면비 4종(3:2 기본), 1~4장 동시 생성, 시드 고정, 화질(Schnell/Dev) 선택
- 한글 입력을 영어 묘사로 자동 변환(fal.ai any-llm), 실패해도 원문으로 진행
- 결과 라이트박스(내려받기 · 프롬프트 복사 · 원본 열기), 최근 24장 localStorage 보관

## API

| 메서드 | 경로 | 요청 body | 응답 |
| --- | --- | --- | --- |
| `GET` | `/api/options` | – | 프리셋·모델·화면비 목록 |
| `POST` | `/api/translate` | `{ text }` | `{ text }` (영어 묘사) |
| `POST` | `/api/generate` | `{ subject, preset, model, ratio, numImages, seed? }` | `{ images[], seed, prompt, preset }` |
| `GET` | `/api/health` | – | `{ status, falKey: 'configured' \| 'missing' }` |

검증 실패는 `400`, fal.ai 오류는 `502`, 키 미설정은 `503`, 90초 초과는 `504`.
