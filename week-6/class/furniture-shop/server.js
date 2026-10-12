// ════════════════════════════════════════════════════════════
// OAK & LINEN — 상품 · 회원 인증 API 서버
// Express 5 + Supabase Postgres (node-postgres) + bcrypt + JWT
// 로컬: node server.js  /  Vercel: module.exports = app
//
//   GET    /api/products      → 상품 목록 (진열 순서대로)
//   GET    /api/products/:id  → 상품 하나
//   POST   /api/auth/signup   → 회원가입 (가입 즉시 로그인 토큰 발급)
//   POST   /api/auth/login    → 로그인 (토큰 발급)
//   GET    /api/auth/me       → 내 정보 🔒
//   POST   /api/orders        → 주문 만들기 (PENDING, 금액은 서버가 DB 가격으로 계산) 🔒
//   GET    /api/orders        → 내 결제 내역 (PAID) 🔒
//   GET    /api/orders/:orderId → 주문 하나 + 결제위젯 초기화 값 🔒
//   POST   /api/payments/confirm → 토스페이먼츠 결제 승인 🔒
//   GET    /api/health        → 헬스체크 (DB 연결 포함)
//   🔒 = Authorization: Bearer <토큰> 필요
//
// 장바구니는 브라우저 localStorage 에 상품 id·색상·수량만 두고, 금액은 서버가 DB 가격으로 계산한다.
// ════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();

// ── DB Pool ──────────────────────────────────────────────────
// Supabase Transaction Pooler(6543). 환경변수에 개행이 섞이는 경우가 있어 .trim() 한다.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,                       // 서버리스 환경을 고려해 작게 유지
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => console.error('[pg pool error]', err.message));

// ── 상수 ─────────────────────────────────────────────────────
const BCRYPT_ROUNDS = 10;        // 해시 1회 ≈ 수십 ms. 무차별 대입을 느리게 만든다.
const TOKEN_TTL = '7d';
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;         // bcrypt 는 72바이트 이후를 잘라내므로 그 이상은 막는다.
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── 초기 상품 데이터 ──────────────────────────────────────────
// 원래 index.html 안에 있던 데모 배열을 그대로 옮겼다. 테이블이 비어 있을 때 한 번만 넣는다.
// (매번 넣으면 관리자가 지운 상품이 서버가 다시 켜질 때마다 되살아난다)
const SEED_PRODUCTS = [
  { id: 'lounge-chair', name: '코드 라운지 체어', en: 'Cord Lounge Chair', category: '거실', price: 890000, image: 'images/lounge-chair.jpg',
    desc: '페이퍼 코드를 손으로 엮은 좌판과 단단한 오크 프레임. 낮고 넓은 앉음새로 오래 머물기 좋은 의자입니다.',
    material: '오크 원목, 페이퍼 코드', size: 'W72 × D74 × H70 cm', colors: ['내추럴 오크', '스모크 오크'], tag: 'BEST' },
  { id: 'linen-sofa', name: '오트밀 리넨 3인 소파', en: 'Oatmeal Linen Sofa', category: '거실', price: 2490000, image: 'images/linen-sofa.jpg',
    desc: '깊은 좌방석과 넉넉한 쿠션. 세탁 가능한 리넨 커버로 오래 두고 쓰기 편합니다.',
    material: '리넨 100% 커버, 페더 혼합 충전재', size: 'W220 × D95 × H72 cm', colors: ['오트밀', '아이보리', '세이지'], tag: 'BEST' },
  { id: 'coffee-table', name: '트래버틴 라운드 커피 테이블', en: 'Travertine Coffee Table', category: '거실', price: 1290000, image: 'images/coffee-table.jpg',
    desc: '자연석 트래버틴 특유의 기공과 결이 살아 있는 원형 테이블. 한 점 한 점 무늬가 다릅니다.',
    material: '천연 트래버틴', size: 'Ø90 × H32 cm', colors: ['베이지 트래버틴'], tag: 'NEW' },
  { id: 'side-table', name: '오크 라운드 사이드 테이블', en: 'Oak Side Table', category: '거실', price: 290000, image: 'images/side-table.jpg',
    desc: '소파 옆, 침대 옆 어디에나 어울리는 작은 원형 테이블.',
    material: '오크 원목, 오일 마감', size: 'Ø45 × H52 cm', colors: ['내추럴 오크', '월넛'] },
  { id: 'ottoman', name: '부클레 라운드 오토만', en: 'Bouclé Ottoman', category: '거실', price: 340000, image: 'images/ottoman.jpg',
    desc: '보송한 부클레 원단의 둥근 오토만. 발받침, 보조 의자, 작은 테이블로 두루 쓰입니다.',
    material: '부클레 원단, 고밀도 폼', size: 'Ø55 × H40 cm', colors: ['아이보리', '샌드'], tag: 'NEW' },
  { id: 'dining-table', name: '월넛 오벌 다이닝 테이블', en: 'Walnut Oval Table', category: '다이닝', price: 1890000, image: 'images/dining-table.jpg',
    desc: '모서리 없는 타원형 상판으로 동선이 부드럽습니다. 4~6인용.',
    material: '월넛 원목, 하드왁스 오일', size: 'W200 × D100 × H74 cm', colors: ['월넛'] },
  { id: 'dining-chair', name: '애쉬 다이닝 체어 (2개 1세트)', en: 'Ash Dining Chair, Set of 2', category: '다이닝', price: 580000, image: 'images/dining-chair.jpg',
    desc: '등을 감싸는 곡선 등받이. 가볍고 단단한 애쉬 원목으로 만들었습니다.',
    material: '애쉬 원목', size: 'W48 × D52 × H78 cm', colors: ['내추럴 애쉬', '블랙 애쉬'] },
  { id: 'pendant-lamp', name: '플리츠 페이퍼 펜던트', en: 'Pleated Paper Pendant', category: '조명', price: 260000, image: 'images/pendant-lamp.jpg',
    desc: '주름 잡힌 한지 셰이드가 빛을 부드럽게 퍼뜨립니다. 식탁 위에 추천합니다.',
    material: '한지, 스틸 프레임', size: 'Ø55 × H48 cm', colors: ['화이트'], tag: 'NEW' },
  { id: 'floor-lamp', name: '라이스페이퍼 플로어 램프', en: 'Rice Paper Floor Lamp', category: '조명', price: 380000, image: 'images/floor-lamp.jpg',
    desc: '달빛처럼 은은한 큰 조명. 거실 한쪽 모서리를 따뜻하게 채웁니다.',
    material: '라이스페이퍼, 오크 베이스', size: 'Ø45 × H150 cm', colors: ['화이트'] },
  { id: 'bed-frame', name: '로우 플랫폼 침대 프레임', en: 'Low Platform Bed', category: '침실', price: 1590000, image: 'images/bed-frame.jpg',
    desc: '바닥에 가깝게 낮춘 플랫폼 침대. 공간이 넓어 보이는 효과가 있습니다.',
    material: '오크 원목, 슬랫 하부', size: 'Q · W170 × D215 × H25 cm', colors: ['내추럴 오크'], tag: 'BEST' },
  { id: 'sideboard', name: '플루티드 오크 사이드보드', en: 'Fluted Sideboard', category: '수납', price: 1690000, image: 'images/sideboard.jpg',
    desc: '세로 홈이 새겨진 슬라이딩 도어. 거실장, 수납장으로 쓰기 좋은 긴 사이드보드.',
    material: '오크 원목·무늬목', size: 'W180 × D45 × H60 cm', colors: ['내추럴 오크', '스모크 오크'] },
  { id: 'bookshelf', name: '슬림 오픈 책장', en: 'Slim Open Shelf', category: '수납', price: 690000, image: 'images/bookshelf.jpg',
    desc: '뒤판 없는 오픈형 구조로 답답하지 않게 책과 오브제를 진열합니다.',
    material: '오크 원목', size: 'W80 × D30 × H180 cm', colors: ['내추럴 오크'] },
];

// ── Lazy DB Init ─────────────────────────────────────────────
// 서버리스는 cold start 마다 호출될 수 있어 플래그 + 공유 Promise 로 중복 실행을 막는다.
let dbInitialized = false;
let initPromise = null;

async function runInit() {
  // 테이블 접두사 furniture_ — Supabase 한 곳을 여러 과제가 공유하므로 이름 충돌을 막는다.
  // 이메일은 소문자로 정규화해 저장하므로 UNIQUE 만으로 대소문자 중복이 막힌다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS furniture_users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- id 는 화면 주소(#/product/lounge-chair)와 사진 파일명에 그대로 쓰는 문자열이다.
    -- 가격이 음수가 되거나 태그 오타가 들어가는 걸 DB 가 직접 막는다.
    CREATE TABLE IF NOT EXISTS furniture_products (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      name_en     TEXT NOT NULL,
      category    TEXT NOT NULL,
      price       INTEGER NOT NULL CHECK (price >= 0),
      image       TEXT NOT NULL,
      description TEXT NOT NULL,
      material    TEXT NOT NULL,
      size        TEXT NOT NULL,
      colors      TEXT[] NOT NULL DEFAULT '{}',
      tag         TEXT CHECK (tag IN ('BEST', 'NEW')),
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 주문 = 결제 1건. 결제창을 열기 전에 PENDING 으로 만들어 두고(금액을 서버가 확정),
    -- 토스 승인이 끝나면 PAID 로 바꾼다. items 는 주문 당시 상품명·가격 스냅샷(나중에 가격이 바뀌어도 내역은 그대로).
    CREATE TABLE IF NOT EXISTS furniture_orders (
      id           SERIAL PRIMARY KEY,
      order_id     TEXT NOT NULL UNIQUE,
      user_id      INTEGER NOT NULL REFERENCES furniture_users(id) ON DELETE CASCADE,
      status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID')),
      order_name   TEXT NOT NULL,
      items        JSONB NOT NULL,
      subtotal     INTEGER NOT NULL CHECK (subtotal >= 0),
      shipping_fee INTEGER NOT NULL CHECK (shipping_fee >= 0),
      amount       INTEGER NOT NULL CHECK (amount > 0),
      recipient    JSONB NOT NULL,
      payment_key  TEXT UNIQUE,
      method       TEXT,
      approved_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS furniture_orders_user_idx ON furniture_orders (user_id, created_at DESC);
  `);

  // 비어 있을 때만 시드. ON CONFLICT 는 콜드 스타트 두 개가 동시에 시드할 때의 중복을 흡수한다.
  const { rows: [{ count }] } = await pool.query('SELECT count(*)::int AS count FROM furniture_products');
  if (count === 0) {
    for (const [i, p] of SEED_PRODUCTS.entries()) {
      await pool.query(
        `INSERT INTO furniture_products
           (id, name, name_en, category, price, image, description, material, size, colors, tag, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.en, p.category, p.price, p.image, p.desc, p.material, p.size, p.colors, p.tag || null, i],
      );
    }
    console.log(`[db] 상품 ${SEED_PRODUCTS.length}개 시드`);
  }
  dbInitialized = true;
}

function initDB() {
  if (dbInitialized) return Promise.resolve();
  if (!initPromise) {
    // 실패하면 다음 요청에서 다시 시도할 수 있도록 Promise 를 비운다.
    initPromise = runInit().catch((err) => { initPromise = null; throw err; });
  }
  return initPromise;
}

// ── 공통 유틸 ────────────────────────────────────────────────
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.userFacing = true;
  return err;
}

// 비밀번호 해시는 절대 응답에 싣지 않는다 — 화면에 필요한 필드만 골라 보낸다.
function publicUser(row) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function validateSignup(body) {
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');

  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw httpError(400, '이메일 형식이 올바르지 않습니다.');
  if (password.length < PASSWORD_MIN) throw httpError(400, `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
  if (Buffer.byteLength(password) > PASSWORD_MAX) throw httpError(400, '비밀번호가 너무 깁니다.');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw httpError(400, '비밀번호에는 영문과 숫자가 모두 들어가야 합니다.');
  }
  return { email, password };
}

// ── 미들웨어 ─────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));

// /api 요청은 DB 준비가 끝난 뒤에 처리한다.
app.use('/api', async (_req, _res, next) => {
  if (!JWT_SECRET) return next(new Error('JWT_SECRET 이 설정되지 않았습니다.'));
  await initDB();
  next();
});

// Authorization: Bearer <토큰> 을 검증해 req.userId 를 채운다.
function requireAuth(req, _res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(httpError(401, '로그인이 필요합니다.'));
  try {
    req.userId = jwt.verify(token, JWT_SECRET).sub;
    next();
  } catch {
    next(httpError(401, '로그인이 만료되었습니다. 다시 로그인해 주세요.'));
  }
}

// ── 라우트 ───────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ success: true, data: { ok: true } });
});

// ── 상품 ─────────────────────────────────────────────────────
// DB 컬럼명(snake_case)을 화면이 원래 쓰던 필드명으로 바꿔 보낸다 → 화면 코드는 그대로 쓸 수 있다.
const PRODUCT_COLUMNS = 'id, name, name_en, category, price, image, description, material, size, colors, tag';
const toProduct = (r) => ({
  id: r.id, name: r.name, en: r.name_en, category: r.category, price: r.price, image: r.image,
  desc: r.description, material: r.material, size: r.size, colors: r.colors, tag: r.tag,
});

// 상품이 12개뿐이라 전부 보내고 검색·정렬은 화면에서 한다. 많아지면 ?category=·페이지네이션을 붙인다.
app.get('/api/products', async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${PRODUCT_COLUMNS} FROM furniture_products ORDER BY sort_order, id`);
  res.json({ success: true, data: rows.map(toProduct) });
});

app.get('/api/products/:id', async (req, res) => {
  const { rows: [row] } = await pool.query(`SELECT ${PRODUCT_COLUMNS} FROM furniture_products WHERE id = $1`, [req.params.id]);
  if (!row) throw httpError(404, '존재하지 않는 상품입니다.');
  res.json({ success: true, data: toProduct(row) });
});

// ── 회원 ─────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = validateSignup(req.body);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const { rows: [user] } = await pool.query(
      `INSERT INTO furniture_users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at`,
      [email, passwordHash],
    );
    res.status(201).json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
  } catch (err) {
    // SELECT 로 미리 확인하면 동시에 들어온 두 요청이 둘 다 통과할 수 있다 → UNIQUE 위반(23505)으로 막는다.
    if (err.code === '23505') throw httpError(409, '이미 가입된 이메일입니다.');
    throw err;
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) throw httpError(400, '이메일과 비밀번호를 입력해 주세요.');

  const { rows: [user] } = await pool.query(
    'SELECT id, email, password_hash, created_at FROM furniture_users WHERE email = $1',
    [email],
  );

  // "없는 이메일"과 "틀린 비밀번호"를 같은 문구로 답한다 — 가입 여부를 드러내지 않기 위해.
  const ok = user && await bcrypt.compare(password, user.password_hash);
  if (!ok) throw httpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');

  res.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { rows: [user] } = await pool.query(
    'SELECT id, email, created_at FROM furniture_users WHERE id = $1',
    [req.userId],
  );
  // 토큰은 유효하지만 회원이 삭제된 경우
  if (!user) throw httpError(401, '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.');
  res.json({ success: true, data: { user: publicUser(user) } });
});

// ── 주문 · 결제 (토스페이먼츠 결제위젯) ─────────────────────
// 흐름: POST /api/orders (PENDING 주문, 금액 확정) → 화면에서 결제위젯 → 토스가 successUrl 로 돌려보냄
//       → POST /api/payments/confirm (서버가 시크릿 키로 승인) → PAID
// 금액은 처음부터 끝까지 서버가 DB 가격으로 정한다. 화면이 보낸 금액은 "주문 금액과 같은지" 확인에만 쓴다.
const FREE_SHIPPING = 500000;
const SHIPPING_FEE = 50000;
const MAX_QTY = 9;
const MAX_LINES = 20;
const PHONE_RE = /^01\d-?\d{3,4}-?\d{4}$/;
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

// 토스 customerKey 는 추측할 수 없는 값이어야 한다 → 회원 id 를 JWT_SECRET 으로 HMAC.
// 같은 회원이면 항상 같은 값이라 DB 에 따로 저장할 필요가 없다. ('_' 포함·36자 — 토스 규칙: 2~50자, 특수문자 1개 이상)
const customerKeyOf = (userId) =>
  'cus_' + crypto.createHmac('sha256', JWT_SECRET).update(String(userId)).digest('hex').slice(0, 32);

// orderId: 6~64자, 영문·숫자·-·_ 만. 추측하기 어렵게 무작위 부분을 붙인다.
function newOrderId() {
  const d = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, ''); // KST 날짜
  return `OL${d}-${crypto.randomBytes(9).toString('base64url')}`;
}

const toOrder = (r) => ({
  orderId: r.order_id, status: r.status, orderName: r.order_name, items: r.items,
  subtotal: r.subtotal, shippingFee: r.shipping_fee, amount: r.amount, recipient: r.recipient,
  method: r.method, approvedAt: r.approved_at, createdAt: r.created_at,
});

function validateRecipient(raw) {
  const name = String(raw?.name ?? '').trim();
  const phone = String(raw?.phone ?? '').trim();
  const address = String(raw?.address ?? '').trim();
  if (!name || name.length > 30) throw httpError(400, '받는 분 이름을 확인해 주세요.');
  if (!PHONE_RE.test(phone)) throw httpError(400, '휴대폰 번호 형식을 확인해 주세요.');
  if (address.length < 5 || address.length > 200) throw httpError(400, '배송지 주소를 확인해 주세요.');
  return { name, phone: phone.replace(/-/g, ''), address };
}

app.post('/api/orders', requireAuth, async (req, res) => {
  const lines = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!lines.length) throw httpError(400, '장바구니가 비어 있습니다.');
  if (lines.length > MAX_LINES) throw httpError(400, `한 번에 ${MAX_LINES}종류까지 주문할 수 있습니다.`);
  const recipient = validateRecipient(req.body?.recipient);

  // 상품 정보는 DB 에서 다시 읽는다 (화면이 보낸 이름·가격은 쓰지 않는다)
  const ids = [...new Set(lines.map((l) => String(l?.id ?? '')))];
  const { rows } = await pool.query(
    'SELECT id, name, price, image, colors FROM furniture_products WHERE id = ANY($1)', [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const items = lines.map((l) => {
    const p = byId.get(String(l?.id ?? ''));
    if (!p) throw httpError(400, '판매하지 않는 상품이 장바구니에 있습니다. 장바구니를 확인해 주세요.');
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw httpError(400, `수량은 1~${MAX_QTY}개로 선택해 주세요.`);
    const color = String(l.color ?? '');
    if (!p.colors.includes(color)) throw httpError(400, `${p.name}의 색상을 다시 선택해 주세요.`);
    return { id: p.id, name: p.name, image: p.image, color, qty, price: p.price };
  });

  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const shippingFee = subtotal >= FREE_SHIPPING ? 0 : SHIPPING_FEE;
  const amount = subtotal + shippingFee;
  const orderName = (items.length > 1 ? `${items[0].name} 외 ${items.length - 1}건` : items[0].name).slice(0, 100);

  const { rows: [row] } = await pool.query(
    `INSERT INTO furniture_orders (order_id, user_id, order_name, items, subtotal, shipping_fee, amount, recipient)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [newOrderId(), req.userId, orderName, JSON.stringify(items), subtotal, shippingFee, amount, JSON.stringify(recipient)],
  );
  res.status(201).json({ success: true, data: toOrder(row) });
});

// 결제 화면이 쓰는 주문 정보 + 위젯 초기화 값. 본인 주문만 보인다.
app.get('/api/orders/:orderId', requireAuth, async (req, res) => {
  const { rows: [row] } = await pool.query(
    `SELECT o.*, u.email FROM furniture_orders o JOIN furniture_users u ON u.id = o.user_id
     WHERE o.order_id = $1 AND o.user_id = $2`,
    [req.params.orderId, req.userId],
  );
  if (!row) throw httpError(404, '주문을 찾을 수 없습니다.');
  if (!process.env.TOSS_CLIENT_KEY) throw httpError(503, '결제 설정이 되어 있지 않습니다. (TOSS_CLIENT_KEY)');
  res.json({
    success: true,
    data: {
      ...toOrder(row),
      // 클라이언트 키는 원래 브라우저용 공개 키다. 키를 바꿀 때 index.html 을 고치지 않도록 서버가 내려준다.
      payment: { clientKey: process.env.TOSS_CLIENT_KEY.trim(), customerKey: customerKeyOf(req.userId), customerEmail: row.email },
    },
  });
});

// 마이페이지 결제 내역 — 결제가 끝난(PAID) 주문만. 결제창에서 그냥 닫은 PENDING 주문은 보여 주지 않는다.
app.get('/api/orders', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM furniture_orders WHERE user_id = $1 AND status = 'PAID' ORDER BY approved_at DESC LIMIT 50`,
    [req.userId],
  );
  res.json({ success: true, data: rows.map(toOrder) });
});

app.post('/api/payments/confirm', requireAuth, async (req, res) => {
  const paymentKey = String(req.body?.paymentKey ?? '');
  const orderId = String(req.body?.orderId ?? '');
  const amount = Number(req.body?.amount);
  if (!paymentKey || !orderId || !Number.isInteger(amount)) throw httpError(400, '결제 정보가 올바르지 않습니다.');

  const { rows: [order] } = await pool.query(
    'SELECT * FROM furniture_orders WHERE order_id = $1 AND user_id = $2', [orderId, req.userId],
  );
  if (!order) throw httpError(404, '주문을 찾을 수 없습니다.');

  // 결제 완료 화면을 새로고침하면 같은 요청이 한 번 더 온다 → 이미 승인된 같은 결제면 그대로 돌려준다
  if (order.status === 'PAID') {
    if (order.payment_key === paymentKey) return res.json({ success: true, data: toOrder(order) });
    throw httpError(409, '이미 결제가 끝난 주문입니다.');
  }
  // successUrl 의 amount 는 주소창에서 고칠 수 있다 → 서버에 저장된 주문 금액과 반드시 비교
  if (amount !== order.amount) throw httpError(400, '결제 금액이 주문 금액과 다릅니다. 결제가 승인되지 않았습니다.');

  const secret = (process.env.TOSS_SECRET_KEY || '').trim();
  if (!secret) throw httpError(503, '결제 설정이 되어 있지 않습니다. (TOSS_SECRET_KEY)');

  // 시크릿 키 뒤에 ':' 를 붙여 base64 → Basic 인증 (콜론을 빠뜨리면 인증 실패)
  let tossRes;
  try {
    tossRes = await fetch(TOSS_CONFIRM_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${secret}:`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw httpError(502, '결제사와 통신하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  const payment = await tossRes.json().catch(() => ({}));
  if (!tossRes.ok) {
    console.error('[toss confirm]', tossRes.status, payment.code, payment.message);
    throw httpError(400, payment.message || '결제 승인에 실패했습니다.');
  }

  // WHERE status = 'PENDING' — 동시에 두 번 승인 처리가 와도 한 번만 PAID 로 바뀐다
  const { rows: [paid] } = await pool.query(
    `UPDATE furniture_orders
        SET status = 'PAID', payment_key = $1, method = $2, approved_at = $3
      WHERE order_id = $4 AND status = 'PENDING'
      RETURNING *`,
    [payment.paymentKey, payment.method || null, payment.approvedAt || new Date().toISOString(), orderId],
  );
  const result = paid || (await pool.query('SELECT * FROM furniture_orders WHERE order_id = $1', [orderId])).rows[0];
  res.json({ success: true, data: toOrder(result) });
});

// 없는 API 경로는 index.html 대신 JSON 404 로 답한다.
app.use('/api', (_req, _res, next) => next(httpError(404, '존재하지 않는 API 입니다.')));

// ── 정적 파일 (로컬 실행용) ──────────────────────────────────
// 폴더 전체를 static 으로 열면 server.js·generate-images.js 까지 내려받을 수 있으므로
// 페이지와 사진 폴더만 연다. (Vercel 에서는 vercel.json 의 static 빌드가 대신 서빙)
app.use('/images', express.static(path.join(__dirname, 'images')));
// /payment/success·/payment/fail 은 토스가 결제 후 돌려보내는 실제 경로 — 같은 index.html 을 내주면 화면이 처리한다
app.get(['/', '/payment/success', '/payment/fail'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── 에러 처리 ────────────────────────────────────────────────
// Express 5 는 async 핸들러에서 던진 에러를 자동으로 여기로 넘긴다.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err.code || '-', err.message);
  // 500 대 에러의 내부 메시지(DB 정보 등)는 화면에 그대로 보내지 않는다.
  const message = err.userFacing ? err.message
    : status === 400 ? '요청 형식이 올바르지 않습니다.'
    : '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  res.status(status).json({ success: false, message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`OAK & LINEN → http://localhost:${PORT}`);
    initDB()
      .then(() => console.log('[db] 준비 완료 (furniture_users, furniture_products, furniture_orders)'))
      .catch((err) => console.error('[db] 초기화 실패:', err.message));
  });
}

module.exports = app;
