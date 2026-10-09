// ════════════════════════════════════════════════════════════
// 과자 쇼핑몰 — API 서버
// Express 5 + Supabase Postgres (node-postgres)
// 로컬: node server.js  /  Vercel: module.exports = app
//
//   GET    /api/categories          → 카테고리 목록 (상품 수 포함)
//   GET    /api/products            → 상품 목록 (?category=&q=&sort=popular|new|price_asc|price_desc)
//   GET    /api/products/:id        → 상품 상세
//   POST   /api/cart/quote          → 장바구니 금액 계산 (현재 가격·재고 기준)
//   POST   /api/orders              → 주문 (재고 차감, 트랜잭션) — 로그인 상태면 내 계정에 연결
//   GET    /api/orders/:orderNo     → 주문 조회 (?phone= 이 맞아야 보여준다)
//
//   POST   /api/auth/signup         → 회원가입 (가입 즉시 로그인 토큰 발급)
//   POST   /api/auth/login          → 로그인
//   GET    /api/me                  → 내 정보          🔒
//   GET    /api/me/orders           → 내 주문내역      🔒
//
//   GET    /api/health              → 헬스체크 (DB 연결 포함)
//   🔒 = Authorization: Bearer <토큰> 필요. 비회원도 주문은 할 수 있다.
// ════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const path = require('path');
const { randomInt } = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();

// ── DB Pool ──────────────────────────────────────────────────
// Supabase Transaction Pooler(6543) 사용. 환경변수에 개행이 섞이는
// 경우가 있어 항상 .trim() 한다.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,                       // 서버리스 환경을 고려해 작게 유지
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => console.error('[pg pool error]', err.message));

// ── 상수 ─────────────────────────────────────────────────────
const FREE_SHIPPING_OVER = 30_000;   // 이 금액 이상이면 무료배송
const SHIPPING_FEE = 3_000;
const MAX_QTY_PER_ITEM = 99;
const MAX_CART_LINES = 50;
const PHONE_RE = /^01[016789]-?\d{3,4}-?\d{4}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 10;        // 해시 1회 ≈ 수십 ms. 무차별 대입을 느리게 만든다.
const TOKEN_TTL = '7d';
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;         // bcrypt 는 72바이트 이후를 잘라내므로 그 이상은 막는다.

const CATEGORIES = [
  { id: 'chips',   name: '스낵',       emoji: '🥔' },
  { id: 'choco',   name: '초콜릿',     emoji: '🍫' },
  { id: 'cookie',  name: '쿠키·비스킷', emoji: '🍪' },
  { id: 'candy',   name: '젤리·사탕',  emoji: '🍬' },
  { id: 'korean',  name: '전통과자',   emoji: '🍘' },
];

// ── 시드 데이터 (테이블이 비어 있을 때 1회 적재) ──────────────
// sold: 인기순 정렬용 초기 판매량. 이후 주문이 들어오면 늘어난다.
const SEED_PRODUCTS = [
  { name: '바삭 감자칩 오리지널', category: 'chips',  price: 1800, stock: 120, sold: 340, emoji: '🥔', color: '#fde68a', weight: '60g',  description: '얇게 썰어 튀긴 감자에 소금만 살짝. 가장 기본이라 가장 맛있는 감자칩.' },
  { name: '매콤 양념 감자칩',     category: 'chips',  price: 1900, stock: 80,  sold: 210, emoji: '🌶️', color: '#fca5a5', weight: '60g',  description: '고춧가루와 마늘로 맛을 낸 매콤달콤 양념 감자칩.' },
  { name: '고소한 옥수수 스낵',   category: 'chips',  price: 1500, stock: 150, sold: 280, emoji: '🌽', color: '#fef08a', weight: '75g',  description: '버터향 가득한 옥수수 모양 스낵. 우유랑 같이 먹으면 꿀맛.' },
  { name: '새우맛 링 스낵',       category: 'chips',  price: 1600, stock: 0,   sold: 410, emoji: '🦐', color: '#fdba74', weight: '90g',  description: '진짜 새우를 넣어 구운 링 모양 스낵. 지금은 품절이에요.' },
  { name: '양파링 스낵',          category: 'chips',  price: 1700, stock: 60,  sold: 190, emoji: '🧅', color: '#e9d5ff', weight: '84g',  description: '달큰한 양파 맛 링 스낵. 손가락에 끼워 먹는 재미.' },
  { name: '진한 다크 초콜릿 70%', category: 'choco',  price: 3200, stock: 40,  sold: 150, emoji: '🍫', color: '#a16207', weight: '100g', description: '카카오 70%의 쌉싸름한 다크 초콜릿. 커피와 잘 어울려요.' },
  { name: '밀크 초코바',          category: 'choco',  price: 1200, stock: 200, sold: 520, emoji: '🍫', color: '#d6a77a', weight: '40g',  description: '캐러멜과 땅콩이 들어간 든든한 밀크 초코바.' },
  { name: '초코 마시멜로 파이',   category: 'choco',  price: 4800, stock: 35,  sold: 380, emoji: '🥧', color: '#c084fc', weight: '12개입', description: '부드러운 빵 사이에 마시멜로, 겉은 초콜릿 코팅. 12개입.' },
  { name: '버터 쿠키 틴',         category: 'cookie', price: 6500, stock: 25,  sold: 90,  emoji: '🍪', color: '#fcd34d', weight: '340g', description: '버터를 듬뿍 넣어 구운 쿠키를 예쁜 틴 케이스에. 선물용으로 좋아요.' },
  { name: '초코칩 쿠키',          category: 'cookie', price: 2500, stock: 90,  sold: 260, emoji: '🍪', color: '#fbbf24', weight: '180g', description: '큼직한 초코칩이 콕콕 박힌 촉촉한 쿠키.' },
  { name: '통밀 다이제 비스킷',   category: 'cookie', price: 2200, stock: 70,  sold: 120, emoji: '🌾', color: '#e7c9a0', weight: '194g', description: '통밀로 만든 담백한 비스킷. 아침 대용으로도 좋아요.' },
  { name: '새콤 곰돌이 젤리',     category: 'candy',  price: 1500, stock: 160, sold: 330, emoji: '🧸', color: '#fda4af', weight: '100g', description: '과일맛 다섯 가지 곰돌이 젤리. 쫀득쫀득.' },
  { name: '레몬 사탕',            category: 'candy',  price: 2000, stock: 100, sold: 140, emoji: '🍋', color: '#fef9c3', weight: '120g', description: '입안이 상쾌해지는 새콤한 레몬 사탕.' },
  { name: '콜라맛 젤리',          category: 'candy',  price: 1300, stock: 5,   sold: 220, emoji: '🥤', color: '#fecaca', weight: '50g',  description: '톡 쏘는 콜라맛 젤리. 재고가 얼마 남지 않았어요!' },
  { name: '찹쌀 약과',            category: 'korean', price: 5500, stock: 30,  sold: 300, emoji: '🍯', color: '#f59e0b', weight: '10개입', description: '조청을 머금은 쫀득한 찹쌀 약과. 10개입.' },
  { name: '쌀 강정',              category: 'korean', price: 4200, stock: 45,  sold: 110, emoji: '🍘', color: '#fde68a', weight: '200g', description: '튀긴 쌀을 조청으로 뭉친 바삭한 쌀 강정.' },
  { name: '전통 유과',            category: 'korean', price: 7800, stock: 20,  sold: 70,  emoji: '🍡', color: '#fbcfe8', weight: '15개입', description: '입에서 사르르 녹는 찹쌀 유과. 명절 선물로 인기.' },
];

// ── Lazy DB Init (스키마 생성 + 최초 시드) ────────────────────
// 서버리스는 cold start 마다 호출될 수 있어 플래그로 중복 실행을 막는다.
let dbInitialized = false;
let initPromise = null;

async function runInit() {
  // 테이블 접두사 snack_ — Supabase 한 곳을 여러 과제가 공유하므로 이름 충돌을 막는다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snack_products (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      category    TEXT NOT NULL,
      price       INTEGER NOT NULL CHECK (price > 0),
      stock       INTEGER NOT NULL CHECK (stock >= 0),   -- 음수 재고는 DB 가 거부한다
      sold        INTEGER NOT NULL DEFAULT 0,
      emoji       TEXT NOT NULL,
      color       TEXT NOT NULL,
      weight      TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS snack_orders (
      id            SERIAL PRIMARY KEY,
      order_no      TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      phone         TEXT NOT NULL,
      address       TEXT NOT NULL,
      memo          TEXT NOT NULL DEFAULT '',
      items_total   INTEGER NOT NULL,
      shipping_fee  INTEGER NOT NULL,
      total         INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'paid',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 주문 당시의 상품명·가격을 복사해 둔다. 나중에 상품 가격이 바뀌어도 주문 내역은 그대로다.
    CREATE TABLE IF NOT EXISTS snack_order_items (
      id         SERIAL PRIMARY KEY,
      order_id   INTEGER NOT NULL REFERENCES snack_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES snack_products(id),
      name       TEXT NOT NULL,
      emoji      TEXT NOT NULL,
      price      INTEGER NOT NULL,
      quantity   INTEGER NOT NULL CHECK (quantity > 0)
    );

    CREATE INDEX IF NOT EXISTS snack_products_category_idx ON snack_products (category);
    CREATE INDEX IF NOT EXISTS snack_order_items_order_id_idx ON snack_order_items (order_id);

    -- 회원. 이메일은 소문자로 정규화해 저장하므로 UNIQUE 만으로 대소문자 중복이 막힌다.
    CREATE TABLE IF NOT EXISTS snack_users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      phone         TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 회원 기능은 주문 테이블보다 나중에 생겨서 ALTER 로 컬럼을 붙인다.
    -- 비회원 주문은 NULL. 회원이 탈퇴해도 주문 기록(매출)은 남도록 SET NULL.
    ALTER TABLE snack_orders ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES snack_users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS snack_orders_user_id_idx ON snack_orders (user_id, created_at DESC);
  `);

  // 비어 있을 때만 시드 — 재실행해도 중복 적재되지 않는다.
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM snack_products');
  if (count === 0) {
    for (const p of SEED_PRODUCTS) {
      await pool.query(
        `INSERT INTO snack_products (name, category, price, stock, sold, emoji, color, weight, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (name) DO NOTHING`,
        [p.name, p.category, p.price, p.stock, p.sold, p.emoji, p.color, p.weight, p.description],
      );
    }
    console.log(`[seed] 상품 ${SEED_PRODUCTS.length}건 적재`);
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
  return err;
}

const toProduct = (r) => ({
  id: r.id, name: r.name, category: r.category, price: r.price, stock: r.stock,
  sold: r.sold, emoji: r.emoji, color: r.color, weight: r.weight, description: r.description,
  createdAt: r.created_at,
});

const shippingFor = (itemsTotal) => (itemsTotal === 0 || itemsTotal >= FREE_SHIPPING_OVER ? 0 : SHIPPING_FEE);

// 장바구니 입력 [{ productId, quantity }] 검증. 같은 상품이 여러 줄이면 합친다.
function parseCartItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw httpError(400, '장바구니가 비어 있습니다.');
  if (raw.length > MAX_CART_LINES) throw httpError(400, '한 번에 주문할 수 있는 상품 종류를 넘었습니다.');
  const merged = new Map();
  for (const it of raw) {
    const id = Number(it?.productId);
    const qty = Number(it?.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0) {
      throw httpError(400, '장바구니 정보가 올바르지 않습니다.');
    }
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  for (const qty of merged.values()) {
    if (qty > MAX_QTY_PER_ITEM) throw httpError(400, `한 상품은 ${MAX_QTY_PER_ITEM}개까지 주문할 수 있습니다.`);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

// 주문번호: 날짜 + 무작위 6자리 (예: 20261006-482913). 순번을 쓰면 남의 주문번호를 쉽게 추측할 수 있다.
function newOrderNo() {
  const d = new Date(Date.now() + 9 * 3600_000);   // KST 기준 날짜
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return `${ymd}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

const normalizePhone = (p) => String(p ?? '').replace(/\D/g, '');

// 비밀번호 해시는 절대 응답에 싣지 않는다 — 화면에 필요한 필드만 골라 보낸다.
const publicUser = (r) => ({ id: r.id, email: r.email, name: r.name, phone: r.phone, createdAt: r.created_at });
const issueToken = (user) => jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });

// 주문 1건 + 상품 목록을 화면용 모양으로. (주문조회와 내 주문내역이 같이 쓴다)
const toOrder = (order, items) => ({
  orderNo: order.order_no, status: order.status, createdAt: order.created_at,
  customer: { name: order.customer_name, phone: order.phone, address: order.address, memo: order.memo },
  items: items.map((i) => ({ productId: i.product_id, name: i.name, emoji: i.emoji, price: i.price, quantity: i.quantity })),
  itemsTotal: order.items_total, shippingFee: order.shipping_fee, total: order.total,
});

// ── 미들웨어 ─────────────────────────────────────────────────
app.use(express.json({ limit: '20kb' }));

// /api 요청은 DB 준비가 끝난 뒤에 처리한다.
app.use('/api', async (_req, _res, next) => {
  if (!JWT_SECRET) return next(new Error('JWT_SECRET 이 설정되지 않았습니다.'));
  await initDB();
  next();
});

// Authorization: Bearer <토큰> 을 검증해 req.userId 를 채운다.
function readToken(req) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    return jwt.verify(token, JWT_SECRET).sub;
  } catch {
    return undefined;   // 토큰은 있는데 만료·위조
  }
}

function requireAuth(req, _res, next) {
  const userId = readToken(req);
  if (userId === null) return next(httpError(401, '로그인이 필요합니다.'));
  if (userId === undefined) return next(httpError(401, '로그인이 만료되었습니다. 다시 로그인해 주세요.'));
  req.userId = userId;
  next();
}

// 로그인은 선택. 토큰이 유효하면 req.userId 를 채우고, 없으면 비회원으로 진행한다.
// 단, 토큰을 보냈는데 만료됐다면 조용히 비회원 주문으로 바꾸지 않고 알려준다 —
// 사용자는 회원으로 주문했다고 생각하는데 내 주문내역에 안 보이는 일이 생기기 때문.
function optionalAuth(req, _res, next) {
  const userId = readToken(req);
  if (userId === undefined) return next(httpError(401, '로그인이 만료되었습니다. 다시 로그인해 주세요.'));
  req.userId = userId;   // null 이면 비회원
  next();
}

// ── 회원 ─────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const name = String(req.body?.name ?? '').trim();
  const phone = String(req.body?.phone ?? '').trim();

  if (!EMAIL_RE.test(email)) throw httpError(400, '이메일 형식이 올바르지 않습니다.');
  if (password.length < PASSWORD_MIN) throw httpError(400, `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
  if (Buffer.byteLength(password) > PASSWORD_MAX) throw httpError(400, '비밀번호가 너무 깁니다.');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw httpError(400, '비밀번호에는 영문과 숫자가 모두 들어가야 합니다.');
  }
  if (name.length < 2 || name.length > 20) throw httpError(400, '이름을 2~20자로 입력해 주세요.');
  if (!PHONE_RE.test(phone)) throw httpError(400, '휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const { rows: [user] } = await pool.query(
      `INSERT INTO snack_users (email, password_hash, name, phone) VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, phone, created_at`,
      [email, passwordHash, name, normalizePhone(phone)],
    );
    res.status(201).json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
  } catch (err) {
    // 미리 SELECT 로 확인하면 동시 가입 요청이 둘 다 통과할 수 있어 UNIQUE 위반(23505)으로 판단한다.
    if (err.code === '23505') throw httpError(409, '이미 가입된 이메일입니다.');
    throw err;
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) throw httpError(400, '이메일과 비밀번호를 입력해 주세요.');

  const { rows: [user] } = await pool.query('SELECT * FROM snack_users WHERE email = $1', [email]);
  // "없는 이메일"과 "틀린 비밀번호"를 같은 문구로 답한다 — 가입 여부를 드러내지 않기 위해.
  const ok = user && await bcrypt.compare(password, user.password_hash);
  if (!ok) throw httpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');
  res.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const { rows: [user] } = await pool.query('SELECT * FROM snack_users WHERE id = $1', [req.userId]);
  if (!user) throw httpError(401, '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.');
  res.json({ success: true, data: { user: publicUser(user) } });
});

app.get('/api/me/orders', requireAuth, async (req, res) => {
  const { rows: orders } = await pool.query(
    'SELECT * FROM snack_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.userId],
  );
  // 주문마다 따로 조회하지 않고(N+1), 한 번에 가져와 주문별로 나눈다.
  const { rows: items } = orders.length
    ? await pool.query(
      'SELECT * FROM snack_order_items WHERE order_id = ANY($1::int[]) ORDER BY id',
      [orders.map((o) => o.id)],
    )
    : { rows: [] };
  res.json({
    success: true,
    data: orders.map((o) => toOrder(o, items.filter((i) => i.order_id === o.id))),
  });
});

// ── 상품 ─────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ success: true, data: { ok: true } });
});

app.get('/api/categories', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT category, COUNT(*)::int AS count FROM snack_products GROUP BY category',
  );
  const counts = Object.fromEntries(rows.map((r) => [r.category, r.count]));
  res.json({
    success: true,
    data: CATEGORIES.map((c) => ({ ...c, count: counts[c.id] || 0 })),
  });
});

const SORTS = {
  popular:    'sold DESC, id',
  new:        'created_at DESC, id DESC',
  price_asc:  'price ASC, id',
  price_desc: 'price DESC, id',
};

app.get('/api/products', async (req, res) => {
  const { category, q, sort } = req.query;
  const where = [];
  const params = [];
  if (category && category !== 'all') {
    params.push(String(category));
    where.push(`category = $${params.length}`);
  }
  if (q && String(q).trim()) {
    // % 와 _ 는 LIKE 의 와일드카드라 사용자가 입력하면 그대로 글자로 취급되도록 이스케이프한다.
    params.push(`%${String(q).trim().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  // ORDER BY 에는 파라미터를 쓸 수 없으므로, 정해진 목록에서만 골라 SQL 주입을 막는다.
  const orderBy = SORTS[sort] || SORTS.popular;
  const { rows } = await pool.query(
    `SELECT * FROM snack_products ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (stock = 0), ${orderBy}`,   // 품절 상품은 항상 뒤로
    params,
  );
  res.json({ success: true, data: rows.map(toProduct) });
});

app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(404, '존재하지 않는 상품입니다.');
  const { rows: [row] } = await pool.query('SELECT * FROM snack_products WHERE id = $1', [id]);
  if (!row) throw httpError(404, '존재하지 않는 상품입니다.');
  res.json({ success: true, data: toProduct(row) });
});

// ── 장바구니 · 주문 ──────────────────────────────────────────
// 장바구니는 브라우저(localStorage)에 상품 id 와 수량만 둔다.
// 가격은 언제든 바뀔 수 있으니, 금액은 항상 서버가 DB 의 현재 가격으로 계산한다.
app.post('/api/cart/quote', async (req, res) => {
  const items = Array.isArray(req.body?.items) && req.body.items.length ? parseCartItems(req.body.items) : [];
  const ids = items.map((i) => i.productId);
  const { rows } = ids.length
    ? await pool.query('SELECT * FROM snack_products WHERE id = ANY($1::int[])', [ids])
    : { rows: [] };
  const byId = new Map(rows.map((r) => [r.id, r]));

  const lines = items
    .filter((i) => byId.has(i.productId))          // 삭제된 상품은 빼고 돌려준다
    .map((i) => {
      const p = byId.get(i.productId);
      return { product: toProduct(p), quantity: i.quantity, subtotal: p.price * i.quantity, enough: p.stock >= i.quantity };
    });
  const itemsTotal = lines.reduce((sum, l) => sum + l.subtotal, 0);
  const shippingFee = shippingFor(itemsTotal);
  res.json({
    success: true,
    data: { lines, itemsTotal, shippingFee, total: itemsTotal + shippingFee, freeShippingOver: FREE_SHIPPING_OVER },
  });
});

app.post('/api/orders', optionalAuth, async (req, res) => {
  const items = parseCartItems(req.body?.items);
  const c = req.body?.customer || {};
  const name = String(c.name ?? '').trim();
  const phone = String(c.phone ?? '').trim();
  const address = String(c.address ?? '').trim();
  const memo = String(c.memo ?? '').trim().slice(0, 100);
  if (name.length < 2 || name.length > 20) throw httpError(400, '받는 분 이름을 2~20자로 입력해 주세요.');
  if (!PHONE_RE.test(phone)) throw httpError(400, '휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)');
  if (address.length < 5 || address.length > 200) throw httpError(400, '배송 주소를 정확히 입력해 주세요.');

  // 재고 확인 → 차감 → 주문 저장을 한 트랜잭션으로 묶는다.
  // 중간에 하나라도 실패하면 ROLLBACK 되어 "재고만 줄고 주문은 없는" 상태가 생기지 않는다.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE: 이 상품 행들을 잠가서, 동시에 들어온 다른 주문이 같은 재고를 두 번 팔지 못하게 한다.
    // id 순으로 잠가야 두 주문이 서로의 잠금을 기다리는 교착(deadlock)이 생기지 않는다.
    const ids = items.map((i) => i.productId).sort((a, b) => a - b);
    const { rows } = await client.query(
      'SELECT * FROM snack_products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    const problems = [];
    for (const it of items) {
      const p = byId.get(it.productId);
      if (!p) problems.push('판매가 종료된 상품이 있습니다.');
      else if (p.stock === 0) problems.push(`'${p.name}'은(는) 품절되었습니다.`);
      else if (p.stock < it.quantity) problems.push(`'${p.name}'은(는) ${p.stock}개까지 주문할 수 있습니다.`);
    }
    if (problems.length) throw httpError(409, problems.join('\n'));

    const itemsTotal = items.reduce((sum, it) => sum + byId.get(it.productId).price * it.quantity, 0);
    const shippingFee = shippingFor(itemsTotal);

    for (const it of items) {
      await client.query(
        'UPDATE snack_products SET stock = stock - $1, sold = sold + $1 WHERE id = $2',
        [it.quantity, it.productId],
      );
    }

    // 주문번호가 우연히 겹치면(UNIQUE 위반) 번호만 바꿔 다시 시도한다.
    let order;
    for (let attempt = 0; !order; attempt++) {
      await client.query('SAVEPOINT order_no');
      try {
        ({ rows: [order] } = await client.query(
          `INSERT INTO snack_orders (order_no, customer_name, phone, address, memo, items_total, shipping_fee, total, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, order_no`,
          [newOrderNo(), name, normalizePhone(phone), address, memo, itemsTotal, shippingFee, itemsTotal + shippingFee, req.userId],
        ));
      } catch (err) {
        if (err.code !== '23505' || attempt >= 4) throw err;
        await client.query('ROLLBACK TO SAVEPOINT order_no');
      }
    }

    for (const it of items) {
      const p = byId.get(it.productId);
      await client.query(
        `INSERT INTO snack_order_items (order_id, product_id, name, emoji, price, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, p.id, p.name, p.emoji, p.price, it.quantity],
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { orderNo: order.order_no, total: itemsTotal + shippingFee } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 토큰은 유효한데 그 사이 탈퇴(삭제)된 회원이면 user_id 외래 키 위반(23503)이 난다.
    if (err.code === '23503' && req.userId) throw httpError(401, '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.');
    throw err;
  } finally {
    client.release();
  }
});

// 주문번호만으로 조회하면 남의 주소·전화번호가 보일 수 있어, 주문할 때 쓴 전화번호까지 맞아야 보여준다.
app.get('/api/orders/:orderNo', async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  const { rows: [order] } = await pool.query(
    'SELECT * FROM snack_orders WHERE order_no = $1 AND phone = $2',
    [String(req.params.orderNo).trim(), phone],
  );
  // 번호가 없는 경우와 전화번호가 틀린 경우를 구분하지 않는다.
  if (!order) throw httpError(404, '주문을 찾을 수 없습니다. 주문번호와 전화번호를 확인해 주세요.');
  const { rows: items } = await pool.query(
    'SELECT product_id, name, emoji, price, quantity FROM snack_order_items WHERE order_id = $1 ORDER BY id',
    [order.id],
  );
  res.json({ success: true, data: toOrder(order, items) });
});

app.use('/api', (_req, _res, next) => next(httpError(404, '존재하지 않는 API 입니다.')));

// ── 정적 파일 (로컬 실행용 — Vercel 은 vercel.json 이 처리) ──
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── 에러 처리 ────────────────────────────────────────────────
// Express 5 는 async 핸들러에서 던진 에러를 자동으로 여기로 넘긴다.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err.code || '-', err.message);
  const message = status >= 500 ? '서버 내부 오류가 발생했습니다.'
    : err.type === 'entity.parse.failed' ? '요청 형식이 올바르지 않습니다.'
    : err.message;
  res.status(status).json({ success: false, message });
});

// ── Startup & Export ─────────────────────────────────────────
if (require.main === module) {
  if (!process.env.DATABASE_URL) console.warn('⚠ DATABASE_URL 이 없습니다. .env 를 확인하세요.');
  app.listen(PORT, () => {
    console.log(`과자 쇼핑몰 → http://localhost:${PORT}`);
    initDB()
      .then(() => console.log('[db] 준비 완료 (snack_products / snack_orders / snack_order_items)'))
      .catch((err) => console.error('[db] 초기화 실패:', err.message));
  });
}

module.exports = app;
