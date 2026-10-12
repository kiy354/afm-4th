# OAK & LINEN — 미니멀 가구 쇼핑몰

빌드 도구 없는 단일 `index.html`(CDN React 18 · Babel · Tailwind)로 만든 가구 쇼핑몰 데모입니다.
상품 데이터와 회원 정보는 Supabase Postgres에 있고, `server.js`(Express 5)가 API로 내줍니다. 로그인은 이메일·비밀번호 + JWT입니다.
**제품 사진 13장은 fal.ai의 Seedream 5.0(Lite)으로 생성**했습니다.

## 화면

| 경로 | 내용 |
|---|---|
| `/#/` | 히어로 · 공간별 카테고리 · 베스트 · 소재 이야기 · 신상품 |
| `/#/shop` | 전체 상품 — 카테고리 탭, 검색, 정렬(추천·신상품·가격) |
| `/#/shop?c=거실` | 카테고리 필터가 적용된 목록 (주소로 공유 가능) |
| `/#/product/:id` | 상품 상세 — 색상 선택, 수량, 상품정보 아코디언, 연관 상품 |
| `/#/cart` | 장바구니 — 수량 변경·삭제, 무료배송 안내, 배송정보 입력 후 데모 주문 |
| `/#/about` | 브랜드 소개 |
| `/#/login` · `/#/signup` | 로그인 · 회원가입 (이미 로그인했으면 원래 가려던 곳으로 이동) |
| `/#/account` | 내 정보 · 로그아웃 (로그인 필요 — 아니면 `/#/login?next=/account`로) |

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/auth/signup` | `{ email, password }` → 가입 + 토큰 발급 |
| POST | `/api/auth/login` | `{ email, password }` → 토큰 발급 |
| GET | `/api/auth/me` | 내 정보 (`Authorization: Bearer <토큰>`) |
| GET | `/api/products` | 상품 전체 (진열 순서대로) |
| GET | `/api/products/:id` | 상품 하나 |
| GET | `/api/health` | DB 연결 확인 |

응답은 `{ success: true, data }` / `{ success: false, message }`.
테이블은 `furniture_users`(회원)와 `furniture_products`(상품) 두 개이고, 서버가 첫 요청 때 자동으로 만듭니다.
상품 테이블이 비어 있으면 처음 12개를 넣습니다(시드).

## 실행

```powershell
cd week-6\class\furniture-shop
npm install
Copy-Item .env.example .env   # DATABASE_URL, JWT_SECRET 입력
npm start                     # http://localhost:3000
```

로그인이 `/api`를 호출하므로 `npx serve`나 Live Server가 아니라 **`npm start`(Express)로 열어야** 합니다.
배포할 때는 `npx vercel env add DATABASE_URL production`, `npx vercel env add JWT_SECRET production`으로 환경변수를 등록합니다.

## 사진 다시 만들기

```powershell
# .env 에 FAL_KEY 입력 후
npm run images
```

이미 `images/`에 있는 파일은 건너뛰므로, 다시 만들고 싶은 사진만 지우고 실행하면 됩니다.
프롬프트는 [generate-images.js](generate-images.js)의 `IMAGES`와 공통 스타일 `STYLE`에 있습니다.

## 구현하면서 해결한 문제

### 1. API 키를 브라우저에 두지 않기 — 사진은 미리 생성
`index.html`에서 fal.ai를 직접 부르면 키가 페이지 소스에 그대로 노출됩니다.
데모 쇼핑몰은 사진이 매번 바뀔 필요가 없으므로, **Node 스크립트로 한 번만 생성해 `images/`에 저장**하고
페이지는 그 파일만 읽게 했습니다. 키는 `.env`(git 제외)에만 있습니다.

### 2. 13장이 한 카탈로그처럼 보이게 — 공통 스타일 프롬프트
상품마다 프롬프트를 따로 쓰면 배경·조명이 제각각이 됩니다. 상품 설명(`subject`) 뒤에
"따뜻한 흰색 스튜디오, 왼쪽 창가 자연광, 베이지 석회벽, 밝은 오크 바닥…" 같은 **공통 문구(`STYLE`)를 붙여**
모든 사진의 톤을 맞췄습니다.

### 3. 429 동시 요청 제한 → 큐 API로 전환
처음엔 동기 엔드포인트(`fal.run`)에 4장씩 동시에 보냈는데, 일부가
`Reached concurrent requests limit of 10`(HTTP 429)로 실패했고 2장으로 줄여도 같았습니다.
동기 엔드포인트는 자리가 없으면 바로 실패하기 때문입니다.
**큐 엔드포인트(`queue.fal.run`)에 제출 → `status_url` 폴링 → `response_url` 조회** 방식으로 바꾸자
제한에 걸려도 차례를 기다렸다가 처리되어 남은 4장이 모두 생성됐습니다.

### 4. 받은 파일은 PNG가 아니라 JPEG
`.png`로 저장했는데 실제로는 JPEG(2304×3072, 장당 약 400KB)였습니다. 확장자를 `.jpg`로 바로잡았고,
용량이 작아서 별도 압축 없이 `loading="lazy"`만 붙여 사용합니다.

### 5. 모달 배경이 화면 일부만 덮던 문제 — `createPortal`
페이지 전환 애니메이션(`fade-up`)이 `transform`을 쓰는데, **`transform`이 걸린 부모 안에서는
`position: fixed`가 화면이 아니라 그 부모 기준**이 됩니다. 그래서 장바구니의 주문 모달 배경이
페이지 높이만큼만 깔렸습니다. 모달을 `ReactDOM.createPortal(..., document.body)`로 body에 직접 그려 해결했습니다.

### 6. 밝은 사진 위 글씨 가독성 · 한글 세리프
히어로 사진이 밝아서 흰 글씨가 묻혔습니다 → 진한 글씨 + 왼쪽 크림색 그라데이션으로 바꿨습니다.
영문 세리프 Cormorant Garamond에는 한글 글리프가 없어 한글 제목이 시스템 명조로 나왔습니다 →
폰트 목록에 `Noto Serif KR`을 이어 붙여 한글만 그 폰트가 받도록 했습니다.

### 7. 장바구니는 `localStorage`에 id·색상·수량만
가격은 저장하지 않고 화면에서 상품 데이터로 다시 계산합니다(백엔드를 붙여도 같은 원칙 — 가격은 서버가 확인).
같은 상품이라도 색상이 다르면 다른 줄로 담기고, `localStorage`가 막힌 환경(시크릿 모드 등)에서도 깨지지 않게 `try/catch`로 감쌌습니다.

### 8. 비밀번호는 bcrypt 해시로, 로그인 실패 문구는 하나로
비밀번호 원문은 저장하지 않고 `bcryptjs` 해시만 저장합니다. bcrypt는 72바이트 이후를 잘라내므로 그보다 긴 비밀번호는 받지 않습니다.
"없는 이메일"과 "틀린 비밀번호"를 같은 문구로 답해, 어떤 이메일이 가입돼 있는지 드러내지 않습니다.
이메일은 소문자로 바꿔 저장하고, 중복 가입은 미리 SELECT하지 않고 **UNIQUE 제약 위반(`23505`)**으로 막습니다 — 동시에 두 요청이 와도 하나만 성공합니다.

### 9. 새로고침해도 로그인 유지 — 확인이 끝나기 전엔 튕기지 않기
토큰은 `localStorage`에 두고, 앱이 켜질 때 `/api/auth/me`로 아직 유효한지 확인합니다.
확인이 끝나기 전에 `/#/account` 가드가 "로그인 안 됨"으로 판단하면 새로고침할 때마다 로그인 페이지로 튕기므로,
**`ready`가 될 때까지는 로딩만 보여 줍니다.** 토큰은 서버가 401(만료·위조)을 줄 때만 지우고, 서버가 잠깐 꺼진 경우엔 로그아웃시키지 않습니다.

### 10. 로그인 후 이동은 가드에서만
로그인 처리 함수와 라우트 가드가 둘 다 페이지를 옮기면 나중에 실행된 쪽이 덮어씁니다(week-5 커뮤니티에서 겪은 문제).
그래서 로그인 함수는 사용자 정보만 저장하고, **`GuestOnly` 가드가 `?next=` 주소로 보냅니다.**
`next`는 `/`로 시작하는 내부 경로만 허용해 외부 사이트로 보내는 데 악용되지 않게 했습니다.

### 11. 서버가 소스 파일을 내주지 않게
폴더 전체를 `express.static`으로 열면 `/server.js`, `/generate-images.js`도 내려받을 수 있습니다. `index.html`과 `images/`만 열었습니다 (`/server.js` → 404 확인).

### 12. 데모 상품을 DB로 옮기기 — 시드는 "비었을 때만"
`index.html`의 상품 배열을 `server.js`의 `SEED_PRODUCTS`로 옮기고, 서버가 처음 켜질 때 `furniture_products`에 넣습니다.
매번 `INSERT … ON CONFLICT DO NOTHING`만 하면 DB에서 지운 상품이 서버가 다시 켜질 때마다 되살아나므로,
**테이블이 비어 있을 때만** 넣습니다. 그래도 서버리스에서 콜드 스타트 두 개가 동시에 시드할 수 있어 `ON CONFLICT`는 그대로 둡니다.
가격이 음수가 되거나 태그 오타가 들어가지 않게 `CHECK` 제약도 걸었습니다.

### 13. 화면 코드는 거의 그대로 — 응답 필드명을 맞춰서
DB 컬럼은 `name_en`, `description`처럼 snake_case지만, API가 화면이 원래 쓰던 `en`, `desc`로 바꿔 보냅니다.
그래서 화면은 `PRODUCTS` 배열 대신 `useProducts()`로 받는 부분만 바꾸면 됐습니다.
상품은 앱이 켜질 때 한 번 불러오고, 불러오는 동안·실패했을 때는 페이지 대신 로딩·"다시 시도" 화면을 보여 줍니다.
카테고리 탭도 DB 상품에서 뽑되, 순서는 `CATEGORY_ORDER`(거실→다이닝→침실→조명→수납)로 고정했습니다.
