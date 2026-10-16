# 앱 구현 관례와 반복되는 함정

week-4에서 앱을 여러 개 만들며 같은 문제를 반복해 만났습니다. 다음 앱에서도 그대로 적용합니다.

## DB

- **테이블 접두사 필수.** Supabase 한 곳을 여러 과제가 공유하므로 `fridge_`, `todo_`처럼
  앱별 접두사를 붙입니다.
- **`DATE` 컬럼은 문자열로 변환해 반환합니다.** `to_char(expiry, 'YYYY-MM-DD')`.
  그대로 내보내면 JS `Date`가 되면서 KST 자정이 UTC로 전날이 되어 **하루가 밀립니다.**
- 여러 테이블에 걸친 쓰기는 `BEGIN`/`COMMIT` 트랜잭션으로 묶습니다.
- 재고처럼 "확인 후 차감"하는 값은 `SELECT … FOR UPDATE`로 행을 잠그고, 여러 행은 **id 순서로** 잠급니다
  (교착 방지). `CHECK (stock >= 0)`으로 DB에서도 한 번 더 막습니다. (week-5/snack-shop)
- 가격·금액은 클라이언트가 보낸 값을 쓰지 않고 서버가 DB 값으로 다시 계산합니다.

## Express

- **구체적인 경로를 파라미터 경로보다 먼저 등록합니다.**
  `DELETE /api/shopping/checked`를 `/:id`보다 뒤에 두면 `checked`가 id로 해석됩니다.
- 응답 형태를 통일합니다: `{ success: true, data }` / `{ success: false, message }`.

## Vercel 서버리스

- **초기화는 한 번만 돌게 만듭니다.** 요청마다 콜드 스타트가 날 수 있으므로,
  스키마 생성은 플래그와 Promise를 공유해 중복 실행을 막고 시드는 테이블이 빌 때만 넣습니다.
- `vercel.json`: `/api/*` → `server.js`, 나머지 → `index.html`.

## 프론트엔드

- 빌드 도구 없이 단일 `index.html` — CDN React 18 + Babel Standalone + Tailwind.
- 라우팅은 외부 라이브러리 없이 **해시 기반 라우터를 직접 구현**합니다 (`#/recipes/3`).
- 페이지 전환 애니메이션에 `transform`을 쓰면 그 안의 `position: fixed`(모달·오버레이)가 화면이 아니라 부모 기준이 됩니다.
  모달은 `ReactDOM.createPortal(..., document.body)`로 그립니다 (week-6/class/furniture-shop).
- 삭제 등은 **낙관적 업데이트** — 화면을 먼저 갱신하고, 실패하면 되돌리고 토스트로 알립니다.

## 인증 (week-5/community)

- 비밀번호는 `bcryptjs` 해시로 저장, 로그인 상태는 JWT(`Authorization: Bearer`). `JWT_SECRET`은 `.env`에.
- 중복 가입은 SELECT로 미리 확인하지 말고 **UNIQUE 제약 + `23505` 에러 처리**로 막습니다 (동시 요청 대비).
- 로그인 실패 문구는 "이메일 또는 비밀번호가 올바르지 않습니다" 하나로 — 가입 여부를 드러내지 않습니다.
- **작성자 확인은 서버가 DB의 `user_id`로** 합니다. 화면에서 버튼을 숨기는 건 편의일 뿐입니다.
- 로그인 후 "원래 가려던 곳"으로 돌려보내는 이동은 **라우트 가드 한 곳에서만** 합니다.
  로그인 처리와 가드가 둘 다 `go()`를 하면 나중에 실행된 쪽이 덮어씁니다.

## 결제 — 토스페이먼츠 결제위젯 (week-5/snack-shop)

- 흐름: 서버가 주문을 `pending`으로 만들고 금액 계산 → 위젯 `setAmount`·`renderPaymentMethods`·`renderAgreement` → `requestPayment`
  → 토스가 `successUrl?paymentKey&orderId&amount`로 돌려보냄 → **서버가** 시크릿 키(Basic `base64("키:")`)로 `/v1/payments/confirm` 호출.
- 승인 전에 돌아온 `amount`가 DB 주문 금액과 같은지 반드시 확인합니다. 클라이언트 키는 브라우저에 내려도 되고, 시크릿 키는 서버에만.
- 해시 라우터 앱은 `successUrl`에 해시를 넣지 말고 `origin + pathname + '?payment=success'`로 받은 뒤, 앱 시작 때 쿼리를 읽고 `history.replaceState`로 지웁니다.
- 재고를 주문 시점에 잡으면 실패·취소·시간 초과 때 되돌려야 합니다. 승인 중 주문은 `FOR UPDATE`, 만료 정리는 `SKIP LOCKED`.
- 토스 4xx는 확정 실패, 5xx·시간 초과는 결과 불명 → 주문을 `pending`으로 둡니다. 승인 후 DB 저장이 실패하면 결제 취소 API를 호출합니다.
- **테스트 상점도 마지막 인증은 실제 사람이 해야 합니다**(카드사 앱·토스 앱 QR). E2E 자동화는 결제창 직전까지 + 서버 검증으로 나눕니다.
- 결제 흐름 전체를 자동으로 시험하려면 `PAYMENT_MODE=test` 같은 **명시적 플래그로만 켜지는 테스트 결제 경로**를 두고, 승인 외의 처리는 실제 결제와 같은 함수를 쓰게 합니다 (기본값은 실제 결제 모드).
- 한 화면에 같이 보이는 시각(주문·결제)은 **같은 시계**(DB `now()`)로 기록합니다. Node `new Date()`와 DB 시계가 수십 초 다를 수 있습니다.
- 배포 사이트와 DB를 같이 쓰면 **기존 컬럼 기본값을 바꾸지 않습니다.** 새 코드가 값을 명시하고, 컬럼은 `ADD COLUMN IF NOT EXISTS`로만 추가합니다.

## 외부 API (OpenAI 등)

- **키는 서버에만 둡니다.** 브라우저는 자기 서버의 `/api`만 호출하고, 외부 호출은 서버가 대행합니다.
- 클라이언트가 보낸 데이터를 믿지 않고 **서버가 DB에서 직접 읽습니다.**
- Structured Outputs를 써도 **값이 이상할 수 있으므로** 저장 전에 길이·범위를 검증·보정합니다.

## AI 이미지 생성 (week-6/class/furniture-shop)

- 바뀔 필요 없는 사진은 **스크립트로 미리 생성해 파일로 저장**합니다. 브라우저에서 생성 API를 부르면 키가 노출됩니다.
- fal.ai는 동기 엔드포인트(`fal.run`)가 동시 요청 제한에 걸리면 바로 429로 실패합니다. 여러 장이면 **큐(`queue.fal.run`) 제출 → 폴링**을 씁니다.
- 여러 장의 톤을 맞추려면 상품 설명 뒤에 배경·조명 묘사를 **공통 문구로 붙입니다.**

## 주가 데이터 — Yahoo Finance (week-6/quest/stock-sim)

- 비공식 API. `v7/finance/quote`는 crumb 없으면 **401** — 대신 키 없이 되는 `v8/finance/chart/<심볼>`의 `meta`를 시세로 씁니다.
  브라우저 `User-Agent` 헤더를 붙이고, 같은 종목은 30초 정도 메모리 캐시합니다.
- `v1/finance/search`는 **한글 검색어에 400**. 한글 이름 → 심볼 별칭 표를 서버에 두고, 6자리 코드는 `.KS` → `.KQ` 순으로 시도합니다.
- 환율은 `KRW=X` 심볼의 차트 meta로 얻습니다. 원화 손익은 "현재가 × 현재 환율 − 원화 원금"으로 계산합니다.
- `vercel link`가 앱 폴더에 만드는 `.gitignore`의 `.env*`는 `.env.example`까지 제외하므로 `!.env.example`을 추가합니다.
