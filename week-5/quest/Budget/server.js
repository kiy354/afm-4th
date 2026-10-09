// ════════════════════════════════════════════════════════════
// 가계부 — API 서버
// Express 5 + Supabase Postgres (node-postgres)
// 로컬: node server.js  /  Vercel: module.exports = app
//
//   GET    /api/categories      → 카테고리 목록
//   POST   /api/categories      → 카테고리 추가
//   DELETE /api/categories/:id  → 카테고리 삭제 (거래가 있으면 거부)
//   GET    /api/entries         → 거래 목록 (?month=YYYY-MM&kind=&categoryId=)
//   POST   /api/entries         → 거래 추가
//   PATCH  /api/entries/:id     → 거래 수정
//   DELETE /api/entries/:id     → 거래 삭제
//   GET    /api/summary         → ★ 카테고리별 합계 (?month=YYYY-MM)
//   GET    /api/months          → 거래가 있는 월 목록
//   GET    /api/health          → 헬스체크 (DB 연결 포함)
// ════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

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
const KINDS = ['expense', 'income'];          // 지출 / 수입
const MAX_MEMO_LENGTH = 200;
const MAX_NAME_LENGTH = 20;
// 원 단위 금액. 1조를 넘는 입력은 오타로 보고 막는다.
const MAX_AMOUNT = 1_000_000_000_000;

// ── 시드 데이터 (최초 1회만 DB로 적재) ────────────────────────
const SEED_CATEGORIES = [
  { name: '식비',      emoji: '🍚', kind: 'expense', color: '#f97316' },
  { name: '교통',      emoji: '🚌', kind: 'expense', color: '#3b82f6' },
  { name: '주거/통신', emoji: '🏠', kind: 'expense', color: '#8b5cf6' },
  { name: '생활용품',  emoji: '🧺', kind: 'expense', color: '#14b8a6' },
  { name: '의료/건강', emoji: '💊', kind: 'expense', color: '#ef4444' },
  { name: '문화/여가', emoji: '🎬', kind: 'expense', color: '#ec4899' },
  { name: '교육',      emoji: '📚', kind: 'expense', color: '#6366f1' },
  { name: '기타지출',  emoji: '🧾', kind: 'expense', color: '#64748b' },
  { name: '급여',      emoji: '💰', kind: 'income',  color: '#22c55e' },
  { name: '용돈',      emoji: '🎁', kind: 'income',  color: '#84cc16' },
  { name: '부수입',    emoji: '📈', kind: 'income',  color: '#10b981' },
];

// daysAgo: 오늘로부터 며칠 전. 이번 달 화면이 비어 보이지 않도록 최근 날짜로 깔아둔다.
const SEED_ENTRIES = [
  { category: '급여',      amount: 3_200_000, memo: '이번 달 급여',   daysAgo: 5 },
  { category: '주거/통신', amount: 650_000,   memo: '월세',           daysAgo: 5 },
  { category: '주거/통신', amount: 55_000,    memo: '휴대폰 요금',    daysAgo: 4 },
  { category: '식비',      amount: 12_000,    memo: '점심 김치찌개',  daysAgo: 4 },
  { category: '식비',      amount: 38_400,    memo: '장보기',         daysAgo: 3 },
  { category: '식비',      amount: 9_500,     memo: '편의점',         daysAgo: 2 },
  { category: '식비',      amount: 25_000,    memo: '친구랑 저녁',    daysAgo: 1 },
  { category: '교통',      amount: 62_000,    memo: '교통카드 충전',  daysAgo: 3 },
  { category: '교통',      amount: 4_800,     memo: '택시',           daysAgo: 1 },
  { category: '생활용품',  amount: 23_900,    memo: '세제·휴지',      daysAgo: 2 },
  { category: '문화/여가', amount: 15_000,    memo: '영화',           daysAgo: 2 },
  { category: '문화/여가', amount: 11_900,    memo: '음악 구독료',    daysAgo: 6 },
  { category: '의료/건강', amount: 8_000,     memo: '감기약',         daysAgo: 6 },
  { category: '교육',      amount: 29_000,    memo: '기술서적',       daysAgo: 7 },
  { category: '용돈',      amount: 100_000,   memo: '명절 용돈',      daysAgo: 7 },
  { category: '부수입',    amount: 180_000,   memo: '중고 판매',      daysAgo: 0 },
  { category: '기타지출',  amount: 50_000,    memo: '경조사비',       daysAgo: 0 },
];

// ── Lazy DB Init (스키마 생성 + 최초 시드) ────────────────────
// 서버리스는 cold start 마다 호출될 수 있어 플래그로 중복 실행을 막는다.
let dbInitialized = false;
let initPromise = null;

async function runInit() {
  const client = await pool.connect();

  try {
    // 테이블 접두사 budget_ — Supabase 한 곳을 여러 과제가 공유하므로 이름 충돌을 막는다.
    await client.query(`
      CREATE TABLE IF NOT EXISTS budget_categories (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        emoji      TEXT NOT NULL DEFAULT '🏷',
        kind       TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
        color      TEXT NOT NULL DEFAULT '#64748b',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (kind, name)
      );

      CREATE TABLE IF NOT EXISTS budget_entries (
        id          SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES budget_categories(id),
        amount      NUMERIC(16, 2) NOT NULL CHECK (amount > 0),
        memo        TEXT NOT NULL DEFAULT '',
        spent_on    DATE NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- 월별 조회와 카테고리별 집계가 주 질의라 두 컬럼에 인덱스를 둔다.
      CREATE INDEX IF NOT EXISTS budget_entries_spent_on_idx    ON budget_entries (spent_on DESC);
      CREATE INDEX IF NOT EXISTS budget_entries_category_id_idx ON budget_entries (category_id);
    `);

    // 비어 있을 때만 시드 — 재실행해도 중복 적재되지 않는다.
    const { rows: [{ count: catCount }] } =
      await client.query('SELECT COUNT(*)::int AS count FROM budget_categories');

    if (catCount === 0) {
      for (const c of SEED_CATEGORIES) {
        await client.query(
          `INSERT INTO budget_categories (name, emoji, kind, color)
           VALUES ($1, $2, $3, $4) ON CONFLICT (kind, name) DO NOTHING`,
          [c.name, c.emoji, c.kind, c.color],
        );
      }
      console.log(`[seed] 카테고리 ${SEED_CATEGORIES.length}건 적재`);
    }

    const { rows: [{ count: entryCount }] } =
      await client.query('SELECT COUNT(*)::int AS count FROM budget_entries');

    if (entryCount === 0) {
      // 카테고리 이름 → id 를 한 번만 읽어 매핑해 둔다.
      const { rows: cats } = await client.query('SELECT id, name FROM budget_categories');
      const idByName = new Map(cats.map((c) => [c.name, c.id]));

      for (const e of SEED_ENTRIES) {
        const categoryId = idByName.get(e.category);
        if (!categoryId) continue;
        await client.query(
          `INSERT INTO budget_entries (category_id, amount, memo, spent_on)
           VALUES ($1, $2, $3, CURRENT_DATE - $4::int)`,
          [categoryId, e.amount, e.memo, e.daysAgo],
        );
      }
      console.log(`[seed] 거래 ${SEED_ENTRIES.length}건 적재`);
    }
  } finally {
    client.release();
  }
}

async function initDB() {
  if (dbInitialized) return;

  // 동시 요청이 몰려도 초기화는 한 번만 수행되도록 promise 를 공유한다.
  if (!initPromise) {
    initPromise = runInit()
      .then(() => { dbInitialized = true; })
      .catch((err) => { initPromise = null; throw err; });
  }

  await initPromise;
}

// ── 입력 검증 헬퍼 ────────────────────────────────────────────
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// 제어문자 — 한 줄 입력에서 걸러낼 대상
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function parseKind(value, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fail('지출/수입 구분을 선택해 주세요.');
    return null;
  }
  if (!KINDS.includes(value)) throw fail('지출/수입 구분이 올바르지 않습니다.');
  return value;
}

function parseName(value) {
  if (typeof value !== 'string') throw fail('카테고리 이름을 입력해 주세요.');
  const name = value.replace(CONTROL_CHARS, '').trim();
  if (!name) throw fail('카테고리 이름을 입력해 주세요.');
  if (name.length > MAX_NAME_LENGTH) {
    throw fail(`카테고리 이름은 ${MAX_NAME_LENGTH}자 이내로 입력해 주세요.`);
  }
  return name;
}

function parseAmount(value) {
  // "12,000" 처럼 콤마가 섞여 들어오는 경우가 있어 먼저 제거한다.
  const raw = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  if (raw === '' || raw === null || raw === undefined) throw fail('금액을 입력해 주세요.');
  const amount = Number(raw);
  if (!Number.isFinite(amount)) throw fail('금액을 숫자로 입력해 주세요.');
  if (amount <= 0) throw fail('금액은 0보다 커야 합니다.');
  if (amount > MAX_AMOUNT) throw fail('금액이 너무 큽니다. 다시 확인해 주세요.');
  return Math.round(amount);     // 원 단위라 소수점은 버린다
}

function parseMemo(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail('메모는 문자열이어야 합니다.');
  const memo = value.replace(CONTROL_CHARS, '').trim();
  if (memo.length > MAX_MEMO_LENGTH) {
    throw fail(`메모는 ${MAX_MEMO_LENGTH}자 이내로 입력해 주세요.`);
  }
  return memo;
}

// YYYY-MM-DD 문자열만 받는다. Date 로 파싱하면 시간대 때문에 날짜가 밀린다.
function parseDate(value) {
  if (value === undefined || value === null || value === '') {
    throw fail('날짜를 선택해 주세요.');
  }
  if (typeof value !== 'string') throw fail('날짜는 YYYY-MM-DD 형식으로 입력해 주세요.');

  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw fail('날짜는 YYYY-MM-DD 형식으로 입력해 주세요.');
  }

  // 형식만 보면 2026-13-99 도 통과한다. 그대로 흘려보내면 Postgres 가
  // 거절하면서 SQLSTATE 를 던지고, 그게 "DB 연결 실패"(503)로 둔갑한다.
  // 실제 달력에 있는 날짜인지 여기서 확인한다. UTC 로 만들어 비교해야
  // 시간대 때문에 하루가 밀리지 않는다.
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw fail('존재하지 않는 날짜입니다.');
  }

  return date;
}

// ?month=YYYY-MM — 없으면 null(전체 기간)
function parseMonth(value) {
  if (value === undefined || value === null || value === '') return null;
  const month = String(value).trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw fail('월은 YYYY-MM 형식으로 입력해 주세요.');
  }
  // parseDate 와 같은 이유 — 13월을 그대로 넘기면 Postgres 쪽에서 터진다.
  const mm = Number(month.slice(5, 7));
  if (mm < 1 || mm > 12) throw fail('존재하지 않는 월입니다.');
  return month;
}

function parseId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw fail(`${label} 값이 올바르지 않습니다.`);
  return id;
}

// ── 행 → 응답 변환 ────────────────────────────────────────────
const toCategory = (row) => ({
  id: row.id,
  name: row.name,
  emoji: row.emoji,
  kind: row.kind,
  color: row.color,
});

// NUMERIC 은 pg 에서 문자열로 오므로 클라이언트에는 숫자로 넘긴다.
const toEntry = (row) => ({
  id: row.id,
  categoryId: row.category_id,
  categoryName: row.category_name,
  categoryEmoji: row.category_emoji,
  categoryColor: row.category_color,
  kind: row.kind,
  amount: Number(row.amount),
  memo: row.memo,
  spentOn: row.spent_on,          // 이미 to_char 로 문자열화된 값
});

// DATE 는 to_char 로 문자열화해서 내보낸다.
// 그대로 내보내면 JS Date 가 되면서 KST 자정이 UTC 로 전날이 되어 하루가 밀린다.
const ENTRY_SELECT = `
  SELECT e.id, e.category_id, e.amount, e.memo,
         to_char(e.spent_on, 'YYYY-MM-DD') AS spent_on,
         c.name AS category_name, c.emoji AS category_emoji,
         c.color AS category_color, c.kind
    FROM budget_entries e
    JOIN budget_categories c ON c.id = e.category_id
`;

// 월 범위 조건을 만든다. date_trunc 로 감싸 비교하면 인덱스를 못 타므로
// [해당 월 1일, 다음 달 1일) 범위 비교로 쓴다.
const monthRangeSql = (placeholder, col = 'e.spent_on') =>
  `${col} >= ${placeholder}::date AND ${col} < (${placeholder}::date + INTERVAL '1 month')`;

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[initDB]', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 초기화에 실패했습니다.' });
  }
});

// ── 헬스체크 ─────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, data: { status: 'ok', db: 'connected' } });
  } catch (err) {
    res.status(503).json({
      success: false,
      message: 'DB에 연결할 수 없습니다.',
      data: { db: err.message },
    });
  }
});

// ── 카테고리 ─────────────────────────────────────────────────
app.get('/api/categories', async (_req, res, next) => {
  try {
    // 지출(expense)을 먼저, 그 안에서는 등록 순서대로 보여준다.
    const { rows } = await pool.query(
      `SELECT id, name, emoji, kind, color FROM budget_categories
        ORDER BY kind DESC, id ASC`,
    );
    res.json({ success: true, data: rows.map(toCategory) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/categories', async (req, res, next) => {
  try {
    const name = parseName(req.body?.name);
    const kind = parseKind(req.body?.kind);
    const emoji = typeof req.body?.emoji === 'string' && req.body.emoji.trim()
      ? [...req.body.emoji.trim()].slice(0, 2).join('')
      : '🏷';
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body?.color || '') ? req.body.color : '#64748b';

    const { rows } = await pool.query(
      `INSERT INTO budget_categories (name, emoji, kind, color)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, name) DO NOTHING
       RETURNING id, name, emoji, kind, color`,
      [name, emoji, kind, color],
    );

    // ON CONFLICT DO NOTHING 이면 rows 가 비므로 중복으로 판단한다.
    if (rows.length === 0) throw fail('같은 이름의 카테고리가 이미 있습니다.', 409);

    res.status(201).json({ success: true, data: toCategory(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/categories/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);

    // 거래가 남아 있으면 지우지 않는다. FK 때문에 DB 에러가 나기 전에
    // 몇 건이 걸려 있는지 알려주는 편이 고치기 쉽다.
    const { rows: [{ count }] } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM budget_entries WHERE category_id = $1',
      [id],
    );
    if (count > 0) {
      throw fail(`이 카테고리에 거래 ${count}건이 있어 삭제할 수 없습니다. 거래를 먼저 지워 주세요.`, 409);
    }

    const { rowCount } = await pool.query('DELETE FROM budget_categories WHERE id = $1', [id]);
    if (rowCount === 0) throw fail('카테고리를 찾을 수 없습니다.', 404);

    res.json({ success: true, message: '삭제했습니다.' });
  } catch (err) {
    next(err);
  }
});

// ── 거래 ─────────────────────────────────────────────────────
app.get('/api/entries', async (req, res, next) => {
  try {
    const month = parseMonth(req.query.month);
    const kind = parseKind(req.query.kind, { required: false });
    const categoryId = req.query.categoryId ? parseId(req.query.categoryId, 'categoryId') : null;

    // 조건을 배열에 모아 $1, $2... 번호를 자동으로 맞춘다.
    const where = [];
    const params = [];

    if (month) {
      params.push(`${month}-01`);
      where.push(monthRangeSql(`$${params.length}`));
    }
    if (kind) {
      params.push(kind);
      where.push(`c.kind = $${params.length}`);
    }
    if (categoryId) {
      params.push(categoryId);
      where.push(`e.category_id = $${params.length}`);
    }

    const { rows } = await pool.query(
      `${ENTRY_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.spent_on DESC, e.id DESC`,
      params,
    );

    res.json({ success: true, data: rows.map(toEntry) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/entries', async (req, res, next) => {
  try {
    const categoryId = parseId(req.body?.categoryId, 'categoryId');
    const amount = parseAmount(req.body?.amount);
    const memo = parseMemo(req.body?.memo);
    const spentOn = parseDate(req.body?.spentOn);

    // FK 위반을 500 으로 흘리지 않고 먼저 확인한다.
    const { rowCount } = await pool.query('SELECT 1 FROM budget_categories WHERE id = $1', [categoryId]);
    if (rowCount === 0) throw fail('카테고리를 찾을 수 없습니다.', 404);

    const { rows: [inserted] } = await pool.query(
      `INSERT INTO budget_entries (category_id, amount, memo, spent_on)
       VALUES ($1, $2, $3, $4::date) RETURNING id`,
      [categoryId, amount, memo, spentOn],
    );

    // 카테고리 이름·색까지 붙은 완성된 형태로 돌려줘야 화면이 바로 그릴 수 있다.
    const { rows } = await pool.query(`${ENTRY_SELECT} WHERE e.id = $1`, [inserted.id]);
    res.status(201).json({ success: true, data: toEntry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/entries/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);

    // 들어온 필드만 골라 부분 수정한다.
    const sets = [];
    const params = [];

    if (req.body?.categoryId !== undefined) {
      const categoryId = parseId(req.body.categoryId, 'categoryId');
      const { rowCount } = await pool.query('SELECT 1 FROM budget_categories WHERE id = $1', [categoryId]);
      if (rowCount === 0) throw fail('카테고리를 찾을 수 없습니다.', 404);
      params.push(categoryId);
      sets.push(`category_id = $${params.length}`);
    }
    if (req.body?.amount !== undefined) {
      params.push(parseAmount(req.body.amount));
      sets.push(`amount = $${params.length}`);
    }
    if (req.body?.memo !== undefined) {
      params.push(parseMemo(req.body.memo));
      sets.push(`memo = $${params.length}`);
    }
    if (req.body?.spentOn !== undefined) {
      params.push(parseDate(req.body.spentOn));
      sets.push(`spent_on = $${params.length}::date`);
    }
    if (sets.length === 0) throw fail('수정할 내용이 없습니다.');

    params.push(id);
    const { rowCount } = await pool.query(
      `UPDATE budget_entries SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
    if (rowCount === 0) throw fail('거래를 찾을 수 없습니다.', 404);

    const { rows } = await pool.query(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
    res.json({ success: true, data: toEntry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/entries/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM budget_entries WHERE id = $1', [id]);
    if (rowCount === 0) throw fail('거래를 찾을 수 없습니다.', 404);
    res.json({ success: true, message: '삭제했습니다.' });
  } catch (err) {
    next(err);
  }
});

// ── ★ 카테고리별 합계 ────────────────────────────────────────
// 집계는 브라우저에서 돌리지 않고 DB 에서 GROUP BY 로 끝낸다.
// 거래가 늘어나도 내려오는 양이 카테고리 수만큼으로 고정된다.
app.get('/api/summary', async (req, res, next) => {
  try {
    const month = parseMonth(req.query.month);
    const params = month ? [`${month}-01`] : [];

    // 거래가 없는 카테고리도 0원으로 보여주려면 LEFT JOIN 이어야 한다.
    // 이때 월 조건을 WHERE 에 두면 거래 없는 쪽이 NULL 이라 탈락하므로,
    // 조건을 반드시 JOIN 의 ON 절에 넣는다.
    const onMonth = month ? `AND ${monthRangeSql('$1')}` : '';

    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.emoji, c.kind, c.color,
              COALESCE(SUM(e.amount), 0) AS total,
              COUNT(e.id)::int           AS count
         FROM budget_categories c
         LEFT JOIN budget_entries e ON e.category_id = c.id ${onMonth}
        GROUP BY c.id, c.name, c.emoji, c.kind, c.color
        ORDER BY c.kind DESC, total DESC, c.id ASC`,
      params,
    );

    const categories = rows.map((row) => ({
      ...toCategory(row),
      total: Number(row.total),
      count: row.count,
    }));

    // 지출/수입 총액은 위 결과를 다시 더해 구한다 (질의를 한 번 더 보내지 않는다).
    const sumOf = (kind) => categories
      .filter((c) => c.kind === kind)
      .reduce((acc, c) => acc + c.total, 0);

    const expenseTotal = sumOf('expense');
    const incomeTotal = sumOf('income');

    // 비율은 같은 구분(지출/수입) 안에서의 점유율로 계산한다.
    const withRatio = categories.map((c) => {
      const base = c.kind === 'expense' ? expenseTotal : incomeTotal;
      return { ...c, ratio: base > 0 ? c.total / base : 0 };
    });

    res.json({
      success: true,
      data: {
        month,
        expenseTotal,
        incomeTotal,
        balance: incomeTotal - expenseTotal,
        entryCount: withRatio.reduce((acc, c) => acc + c.count, 0),
        categories: withRatio,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── ★ 월별 집계 (집계표 + 차트용) ────────────────────────────
// 월 × 카테고리로 한 번만 GROUP BY 하고, 월 합계·총계는 그 결과를 접어서 만든다.
// 질의를 월별·카테고리별로 나눠 두 번 보내면 합계가 서로 어긋날 여지가 생긴다.
app.get('/api/monthly', async (req, res, next) => {
  try {
    // 표가 끝없이 길어지지 않도록 최근 N개월만. 1~60 사이로 가둔다.
    const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 60);

    const [{ rows: catRows }, { rows: gridRows }] = await Promise.all([
      pool.query('SELECT id, name, emoji, kind, color FROM budget_categories ORDER BY kind DESC, id ASC'),
      pool.query(
        `SELECT to_char(e.spent_on, 'YYYY-MM') AS month,
                e.category_id,
                SUM(e.amount)    AS total,
                COUNT(*)::int    AS count
           FROM budget_entries e
          GROUP BY month, e.category_id
          ORDER BY month ASC`,
      ),
    ]);

    const categories = catRows.map(toCategory);
    const kindById = new Map(categories.map((c) => [c.id, c.kind]));

    // 데이터가 있는 달만 쓰면 중간에 빈 달이 사라져 시간축이 왜곡된다.
    // 가장 이른 달부터 가장 늦은 달까지 빠짐없이 채운다.
    const present = [...new Set(gridRows.map((r) => r.month))].sort();
    let months = [];
    if (present.length > 0) {
      const step = (m, d) => {
        const [y, mm] = m.split('-').map(Number);
        const dt = new Date(Date.UTC(y, mm - 1 + d, 1));
        return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
      };
      for (let m = present[0]; m <= present[present.length - 1]; m = step(m, 1)) months.push(m);
    }
    // 최근 N개월만 남긴다 (오래된 쪽을 자른다).
    months = months.slice(-limit);
    const inRange = new Set(months);

    // 월 합계
    const byMonth = new Map(months.map((m) => [m, { month: m, income: 0, expense: 0, balance: 0, count: 0 }]));
    // 카테고리 × 월
    const byCat = new Map(categories.map((c) => [c.id, { total: 0, count: 0, byMonth: {} }]));
    for (const m of months) for (const c of categories) byCat.get(c.id).byMonth[m] = 0;

    for (const row of gridRows) {
      if (!inRange.has(row.month)) continue;           // 잘라낸 달은 건너뛴다
      const kind = kindById.get(row.category_id);
      if (!kind) continue;                             // 카테고리가 지워진 경우 방어
      const total = Number(row.total);

      const bucket = byMonth.get(row.month);
      bucket[kind === 'income' ? 'income' : 'expense'] += total;
      bucket.count += row.count;

      const cat = byCat.get(row.category_id);
      cat.byMonth[row.month] = total;
      cat.total += total;
      cat.count += row.count;
    }

    const rows = months.map((m) => {
      const b = byMonth.get(m);
      return { ...b, balance: b.income - b.expense };
    });

    const totals = rows.reduce(
      (acc, r) => ({
        income: acc.income + r.income,
        expense: acc.expense + r.expense,
        count: acc.count + r.count,
      }),
      { income: 0, expense: 0, count: 0 },
    );
    totals.balance = totals.income - totals.expense;
    totals.monthCount = rows.length;

    // 월평균은 "거래가 있었던 달"이 아니라 표에 보이는 달 수로 나눈다.
    // 빈 달도 0원을 쓴 달이므로 평균에 포함되어야 한다.
    const n = rows.length || 1;
    const averages = {
      income: Math.round(totals.income / n),
      expense: Math.round(totals.expense / n),
      balance: Math.round(totals.balance / n),
    };

    res.json({
      success: true,
      data: {
        months,
        rows,
        totals,
        averages,
        categories: categories.map((c) => ({ ...c, ...byCat.get(c.id) })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── 거래가 있는 월 목록 (월 선택 드롭다운용) ──────────────────
app.get('/api/months', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT to_char(spent_on, 'YYYY-MM') AS month, COUNT(*)::int AS count
         FROM budget_entries
        GROUP BY month
        ORDER BY month DESC`,
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ── 정의되지 않은 API 경로 ────────────────────────────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API 경로입니다.' });
});

// ── SPA fallback (Express 5 문법) ─────────────────────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────
// DB 에 닿지 못한 경우에만 503. SQLSTATE 전체를 503 으로 묶으면
// 잘못된 입력(22xxx)·제약 위반(23xxx)까지 "DB 연결 실패"로 보고되어
// 원인을 찾을 수 없게 된다.
//   08xxx 연결 예외 / 53xxx 자원 부족 / 57Pxx 관리자 개입(셧다운)
const DB_DOWN_SQLSTATE = /^(08|53|57P)/;
const DB_DOWN_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET']);

function statusOf(err) {
  if (err.status) return err.status;                       // 검증 실패 등
  const code = err.code ? String(err.code) : '';
  if (DB_DOWN_CODES.has(code) || DB_DOWN_SQLSTATE.test(code)) return 503;
  return 500;
}

app.use((err, _req, res, _next) => {
  const status = statusOf(err);
  // 500/503 은 원인을 알아야 하니 서버 로그에 SQLSTATE 까지 남긴다.
  if (status >= 500) console.error('[error]', err.code || '-', err.message);
  const message = status === 503
    ? '데이터베이스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    : status >= 500 ? '서버 내부 오류가 발생했습니다.' : err.message;
  res.status(status).json({ success: false, message });
});

// ── Startup & Export ─────────────────────────────────────────
if (require.main === module) {
  // `node server.js --seed` 로 스키마 생성 + 시드만 실행하고 종료한다.
  if (process.argv.includes('--seed')) {
    initDB()
      .then(() => { console.log('[seed] 완료'); return pool.end(); })
      .then(() => process.exit(0))
      .catch((err) => { console.error('[seed] 실패:', err.message); process.exit(1); });
  } else {
    if (!process.env.DATABASE_URL) {
      console.warn('⚠ DATABASE_URL 이 없습니다. .env 를 확인하세요 (.env.example 참고).');
    }
    app.listen(PORT, () => {
      console.log(`가계부   → http://localhost:${PORT}`);
      console.log('저장소   → Supabase PostgreSQL (budget_categories / budget_entries)');
      initDB()
        .then(() => console.log('[db] 준비 완료'))
        .catch((err) => console.error('[db] 초기화 실패:', err.message));
    });
  }
}

module.exports = app;
