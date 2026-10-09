// ════════════════════════════════════════════════════════════
// 냉장고 요리사 — API 서버
// Express 5 + Supabase Postgres (node-postgres)
// 로컬: node server.js  /  Vercel: module.exports = app
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
const connectionString = (process.env.DATABASE_URL || '').trim();

// ── OpenAI (레시피 생성) ──────────────────────────────────────
// 키는 서버에서만 사용하며 클라이언트로 내려보내지 않는다.
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,                       // 서버리스 환경을 고려해 작게 유지
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => console.error('[pg pool error]', err.message));

// ── 시드 데이터 (최초 1회만 DB로 적재) ────────────────────────
const SEED_INGREDIENTS = [
  { name: '계란',       emoji: '🥚', category: '유제품',   qty: 10,  unit: '개', place: '냉장', days: 9 },
  { name: '우유',       emoji: '🥛', category: '유제품',   qty: 1,   unit: 'L',  place: '냉장', days: 2 },
  { name: '토마토',     emoji: '🍅', category: '채소',     qty: 4,   unit: '개', place: '냉장', days: 5 },
  { name: '양파',       emoji: '🧅', category: '채소',     qty: 3,   unit: '개', place: '실온', days: 21 },
  { name: '대파',       emoji: '🌿', category: '채소',     qty: 2,   unit: '대', place: '냉장', days: 4 },
  { name: '애호박',     emoji: '🥒', category: '채소',     qty: 1,   unit: '개', place: '냉장', days: 6 },
  { name: '감자',       emoji: '🥔', category: '채소',     qty: 5,   unit: '개', place: '실온', days: 30 },
  { name: '당근',       emoji: '🥕', category: '채소',     qty: 3,   unit: '개', place: '냉장', days: 12 },
  { name: '마늘',       emoji: '🧄', category: '채소',     qty: 1,   unit: '통', place: '냉장', days: 18 },
  { name: '닭가슴살',   emoji: '🍗', category: '육류',     qty: 400, unit: 'g',  place: '냉동', days: 45 },
  { name: '삼겹살',     emoji: '🥓', category: '육류',     qty: 500, unit: 'g',  place: '냉장', days: 1 },
  { name: '새우',       emoji: '🍤', category: '해산물',   qty: 300, unit: 'g',  place: '냉동', days: 60 },
  { name: '두부',       emoji: '🧊', category: '가공식품', qty: 1,   unit: '모', place: '냉장', days: -1 },
  { name: '즉석밥',     emoji: '🍚', category: '곡물',     qty: 3,   unit: '개', place: '실온', days: 120 },
  { name: '치즈',       emoji: '🧀', category: '유제품',   qty: 5,   unit: '장', place: '냉장', days: 14 },
  { name: '버터',       emoji: '🧈', category: '유제품',   qty: 200, unit: 'g',  place: '냉장', days: 25 },
  { name: '김치',       emoji: '🥬', category: '반찬',     qty: 1,   unit: '통', place: '냉장', days: 40 },
  { name: '스파게티면', emoji: '🍝', category: '곡물',     qty: 500, unit: 'g',  place: '실온', days: 200 },
];

const SEED_RECIPES = [
  {
    name: '토마토 계란 볶음', emoji: '🍳', minutes: 15, difficulty: '쉬움', servings: 2,
    tags: ['한그릇', '자취요리'],
    summary: '냉장고에 늘 있는 재료로 10분 만에 끝나는 중식 가정식.',
    ingredients: [
      { name: '계란', amount: '3개' },
      { name: '토마토', amount: '2개' },
      { name: '대파', amount: '1대' },
      { name: '마늘', amount: '2쪽' },
    ],
    steps: [
      '토마토는 한입 크기로 썰고, 대파와 마늘은 잘게 다진다.',
      '계란 3개를 풀어 소금 한 꼬집을 넣고 반숙으로 스크램블한 뒤 따로 덜어둔다.',
      '팬에 기름을 두르고 다진 마늘과 대파를 볶아 향을 낸다.',
      '토마토를 넣고 물러질 때까지 3분간 볶는다.',
      '덜어둔 계란을 다시 넣고 살살 섞은 뒤 불을 끈다.',
    ],
  },
  {
    name: '감자 된장국', emoji: '🍲', minutes: 25, difficulty: '쉬움', servings: 2,
    tags: ['국물', '집밥'],
    summary: '포슬포슬한 감자와 두부가 들어간 기본 된장국.',
    ingredients: [
      { name: '감자', amount: '2개' },
      { name: '양파', amount: '1/2개' },
      { name: '대파', amount: '1대' },
      { name: '두부', amount: '1/2모' },
      { name: '된장', amount: '2큰술' },
    ],
    steps: [
      '냄비에 물 700ml를 붓고 된장 2큰술을 체에 걸러 푼다.',
      '감자와 양파를 먹기 좋게 썰어 넣고 중불에서 10분 끓인다.',
      '감자가 익으면 두부를 깍둑썰어 넣는다.',
      '마지막에 대파를 올리고 2분 더 끓인 뒤 불을 끈다.',
    ],
  },
  {
    name: '새우 로제 파스타', emoji: '🍝', minutes: 30, difficulty: '보통', servings: 2,
    tags: ['양식', '데이트'],
    summary: '토마토와 생크림을 반반 섞어 부드럽게 만든 로제 소스 파스타.',
    ingredients: [
      { name: '스파게티면', amount: '200g' },
      { name: '새우', amount: '150g' },
      { name: '토마토', amount: '2개' },
      { name: '마늘', amount: '3쪽' },
      { name: '버터', amount: '15g' },
      { name: '생크림', amount: '150ml' },
    ],
    steps: [
      '끓는 소금물에 스파게티면을 포장 표기보다 1분 짧게 삶는다.',
      '팬에 버터를 녹이고 편 썬 마늘을 볶아 향을 낸다.',
      '손질한 새우를 넣어 겉면만 익힌 뒤 잠시 덜어둔다.',
      '깍둑썬 토마토를 으깨듯 볶다가 생크림을 붓고 3분간 졸인다.',
      '삶은 면과 새우를 넣고 면수를 조금씩 더해 소스 농도를 맞춘다.',
    ],
  },
  {
    name: '닭가슴살 샐러드', emoji: '🥗', minutes: 20, difficulty: '쉬움', servings: 1,
    tags: ['다이어트', '단백질'],
    summary: '기름 없이 구운 닭가슴살을 채소와 함께 담아낸 한 끼 샐러드.',
    ingredients: [
      { name: '닭가슴살', amount: '200g' },
      { name: '토마토', amount: '1개' },
      { name: '당근', amount: '1/2개' },
      { name: '올리브오일', amount: '1큰술' },
    ],
    steps: [
      '닭가슴살에 소금·후추를 뿌려 10분 재운다.',
      '달군 팬에 올려 앞뒤로 각 5분씩 굽고 5분간 레스팅한다.',
      '토마토는 웨지로, 당근은 얇게 채 썬다.',
      '닭가슴살을 도톰하게 썰어 채소 위에 올리고 올리브오일을 두른다.',
    ],
  },
  {
    name: '김치 삼겹살 볶음밥', emoji: '🍚', minutes: 20, difficulty: '쉬움', servings: 2,
    tags: ['한그릇', '자취요리'],
    summary: '잘 익은 김치와 삼겹살 기름으로 볶아낸 실패 없는 볶음밥.',
    ingredients: [
      { name: '삼겹살', amount: '200g' },
      { name: '김치', amount: '1컵' },
      { name: '즉석밥', amount: '2개' },
      { name: '계란', amount: '2개' },
      { name: '대파', amount: '1대' },
    ],
    steps: [
      '삼겹살을 한입 크기로 썰어 기름이 나올 때까지 볶는다.',
      '송송 썬 대파를 넣어 파기름을 낸다.',
      '김치를 넣고 신맛이 날아갈 때까지 4분간 볶는다.',
      '데운 즉석밥을 넣고 주걱으로 눌러가며 고슬하게 볶는다.',
      '접시에 담고 반숙 프라이를 올려 완성한다.',
    ],
  },
  {
    name: '애호박 치즈전', emoji: '🥘', minutes: 15, difficulty: '쉬움', servings: 2,
    tags: ['반찬', '아이반찬'],
    summary: '애호박에 계란옷을 입히고 치즈를 올려 구운 간단 반찬.',
    ingredients: [
      { name: '애호박', amount: '1개' },
      { name: '계란', amount: '2개' },
      { name: '치즈', amount: '2장' },
      { name: '부침가루', amount: '3큰술' },
    ],
    steps: [
      '애호박을 0.7cm 두께로 둥글게 썰어 소금을 살짝 뿌린다.',
      '부침가루를 앞뒤로 얇게 묻힌 뒤 풀어둔 계란물에 담근다.',
      '약불로 달군 팬에 올려 노릇하게 앞뒤로 굽는다.',
      '뒤집은 면에 치즈를 4등분해 올리고 뚜껑을 덮어 30초간 녹인다.',
    ],
  },
];

const SEED_SHOPPING = ['올리브오일'];

// ── Lazy DB Init (스키마 생성 + 최초 시드) ────────────────────
// 서버리스는 cold start 마다 호출될 수 있어 플래그로 중복 실행을 막는다.
let dbInitialized = false;
let initPromise = null;

async function runInit() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fridge_ingredients (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        emoji      TEXT NOT NULL DEFAULT '🧺',
        category   TEXT NOT NULL,
        qty        NUMERIC NOT NULL DEFAULT 1,
        unit       TEXT NOT NULL DEFAULT '개',
        place      TEXT NOT NULL DEFAULT '냉장',
        expiry     DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS fridge_recipes (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        emoji      TEXT NOT NULL DEFAULT '🍽',
        minutes    INTEGER NOT NULL DEFAULT 0,
        difficulty TEXT NOT NULL DEFAULT '쉬움',
        servings   INTEGER NOT NULL DEFAULT 1,
        summary    TEXT NOT NULL DEFAULT '',
        tags       TEXT[] NOT NULL DEFAULT '{}',
        steps      TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- AI 로 생성된 레시피를 구분하는 플래그 (기존 테이블에도 안전하게 추가)
      ALTER TABLE fridge_recipes ADD COLUMN IF NOT EXISTS is_ai BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE fridge_recipes ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS fridge_recipe_ingredients (
        id         SERIAL PRIMARY KEY,
        recipe_id  INTEGER NOT NULL REFERENCES fridge_recipes(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        amount     TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      -- 요리 기록. 레시피가 지워져도 기록은 남도록 이름을 따로 저장하고 FK 는 NULL 로 둔다.
      CREATE TABLE IF NOT EXISTS fridge_cook_logs (
        id          SERIAL PRIMARY KEY,
        recipe_id   INTEGER REFERENCES fridge_recipes(id) ON DELETE SET NULL,
        recipe_name TEXT NOT NULL,
        cooked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- RECIPE_SELECT 가 레시피마다 recipe_id 로 기록을 세므로 인덱스를 둔다.
      CREATE INDEX IF NOT EXISTS fridge_cook_logs_recipe_id_idx ON fridge_cook_logs (recipe_id);

      CREATE TABLE IF NOT EXISTS fridge_shopping_items (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        checked    BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 비어 있을 때만 시드 — 재실행해도 중복 적재되지 않는다.
    const { rows: [{ count: ingCount }] } = await client.query('SELECT COUNT(*)::int AS count FROM fridge_ingredients');

    if (ingCount === 0) {
      for (const it of SEED_INGREDIENTS) {
        await client.query(
          `INSERT INTO fridge_ingredients (name, emoji, category, qty, unit, place, expiry)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE + $7::int)`,
          [it.name, it.emoji, it.category, it.qty, it.unit, it.place, it.days],
        );
      }
      console.log(`[seed] 재료 ${SEED_INGREDIENTS.length}건 적재`);
    }

    const { rows: [{ count: recipeCount }] } = await client.query('SELECT COUNT(*)::int AS count FROM fridge_recipes');

    if (recipeCount === 0) {
      for (const r of SEED_RECIPES) {
        const { rows: [recipe] } = await client.query(
          `INSERT INTO fridge_recipes (name, emoji, minutes, difficulty, servings, summary, tags, steps)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [r.name, r.emoji, r.minutes, r.difficulty, r.servings, r.summary, r.tags, r.steps],
        );

        for (let i = 0; i < r.ingredients.length; i += 1) {
          const ri = r.ingredients[i];
          await client.query(
            `INSERT INTO fridge_recipe_ingredients (recipe_id, name, amount, sort_order)
             VALUES ($1, $2, $3, $4)`,
            [recipe.id, ri.name, ri.amount, i],
          );
        }
      }
      console.log(`[seed] 레시피 ${SEED_RECIPES.length}건 적재`);
    }

    const { rows: [{ count: shopCount }] } = await client.query('SELECT COUNT(*)::int AS count FROM fridge_shopping_items');

    if (shopCount === 0) {
      for (const name of SEED_SHOPPING) {
        await client.query('INSERT INTO fridge_shopping_items (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
      }
      console.log(`[seed] 장보기 ${SEED_SHOPPING.length}건 적재`);
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

// DATE 컬럼은 JS Date 로 오면 타임존 때문에 하루 밀릴 수 있어
// 항상 문자열로 뽑는다.
const INGREDIENT_COLUMNS = `
  id, name, emoji, category, qty::float AS qty, unit, place,
  to_char(expiry, 'YYYY-MM-DD') AS expiry
`;

const PLACES = ['냉장', '냉동', '실온'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 재료 입력값 검증 — 추가·수정·장보기 입고가 함께 쓴다.
 * partial=true(수정)면 요청에 들어온 필드만 검사한다.
 * 성공 시 { values }, 실패 시 { error }.
 */
function parseIngredientFields(body, { partial = false } = {}) {
  const { name, emoji, category, qty, unit, place, expiry } = body || {};
  const need = (v) => v !== undefined || !partial;
  const values = {};

  if (need(name)) {
    if (!name || !String(name).trim()) return { error: '재료 이름(name)은 필수입니다.' };
    values.name = String(name).trim();
  }
  if (need(category)) {
    if (!category || !String(category).trim()) return { error: '분류(category)는 필수입니다.' };
    values.category = String(category).trim();
  }
  if (need(expiry)) {
    if (!expiry || !DATE_RE.test(expiry)) return { error: '유통기한(expiry)은 YYYY-MM-DD 형식이어야 합니다.' };
    values.expiry = expiry;
  }
  if (qty !== undefined) {
    const numericQty = Number(qty);
    if (Number.isNaN(numericQty) || numericQty <= 0) return { error: '수량(qty)은 0보다 큰 숫자여야 합니다.' };
    values.qty = numericQty;
  } else if (!partial) {
    values.qty = 1;
  }
  if (need(unit)) values.unit = String(unit || '').trim() || '개';
  if (need(place)) {
    // 추가할 때는 기존처럼 '냉장'으로 보정하지만, 수정할 때 잘못된 값을 조용히 바꾸면
    // 사용자가 고른 값과 다른 값이 저장되므로 오류로 돌려준다.
    if (partial && !PLACES.includes(place)) return { error: `보관 위치(place)는 ${PLACES.join('/')} 중 하나여야 합니다.` };
    values.place = PLACES.includes(place) ? place : '냉장';
  }
  if (need(emoji)) values.emoji = emoji || '🧺';

  return { values };
}

/** 검증된 values 목록을 쿼리 한 번으로 넣는다 (unnest). db 는 pool 또는 트랜잭션 client. */
async function insertIngredients(db, list) {
  if (list.length === 0) return [];

  const columns = ['name', 'emoji', 'category', 'qty', 'unit', 'place', 'expiry'];
  const { rows } = await db.query(
    `INSERT INTO fridge_ingredients (${columns.join(', ')})
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::text[], $6::text[], $7::date[])
     RETURNING ${INGREDIENT_COLUMNS}`,
    columns.map((key) => list.map((v) => v[key])),
  );
  return rows;
}

// ════════════════════════════════════════════════════════════
// 🧊 재료 (ingredients)
// ════════════════════════════════════════════════════════════
app.get('/api/ingredients', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${INGREDIENT_COLUMNS} FROM fridge_ingredients ORDER BY expiry ASC, id ASC`,
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

app.post('/api/ingredients', async (req, res, next) => {
  try {
    const { values, error } = parseIngredientFields(req.body);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const [created] = await insertIngredients(pool, [values]);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

// 보낸 필드만 바꾼다 (예: { qty: 3 } 이면 수량만 수정).
app.patch('/api/ingredients/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }

    const { values, error } = parseIngredientFields(req.body, { partial: true });

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const keys = Object.keys(values);

    if (keys.length === 0) {
      return res.status(400).json({ success: false, message: '수정할 항목이 없습니다.' });
    }

    // 컬럼 이름은 parseIngredientFields 가 정한 키에서만 나오므로 SQL 에 넣어도 안전하다.
    const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');

    const { rows } = await pool.query(
      `UPDATE fridge_ingredients SET ${sets} WHERE id = $1 RETURNING ${INGREDIENT_COLUMNS}`,
      [id, ...keys.map((key) => values[key])],
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 재료를 찾을 수 없습니다.' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/ingredients/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }

    const { rowCount } = await pool.query('DELETE FROM fridge_ingredients WHERE id = $1', [id]);

    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 재료를 찾을 수 없습니다.' });
    }

    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════
// 📖 레시피 (recipes) — 재료 목록을 JSON 으로 묶어서 반환
// ════════════════════════════════════════════════════════════
const RECIPE_SELECT = `
  SELECT
    r.id, r.name, r.emoji, r.minutes, r.difficulty, r.servings, r.summary, r.tags, r.steps, r.is_ai, r.is_favorite,
    (SELECT COUNT(*)::int FROM fridge_cook_logs c WHERE c.recipe_id = r.id) AS cook_count,
    (SELECT to_char(MAX(c.cooked_at) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')
       FROM fridge_cook_logs c WHERE c.recipe_id = r.id) AS last_cooked,
    COALESCE(
      json_agg(
        json_build_object('name', ri.name, 'amount', ri.amount)
        ORDER BY ri.sort_order
      ) FILTER (WHERE ri.id IS NOT NULL),
      '[]'
    ) AS ingredients
  FROM fridge_recipes r
  LEFT JOIN fridge_recipe_ingredients ri ON ri.recipe_id = r.id
`;

app.get('/api/recipes', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`${RECIPE_SELECT} GROUP BY r.id ORDER BY r.id ASC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

app.get('/api/recipes/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }

    const { rows } = await pool.query(`${RECIPE_SELECT} WHERE r.id = $1 GROUP BY r.id`, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 레시피를 찾을 수 없습니다.' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════
// ✨ AI 레시피 생성 (OpenAI)
// ════════════════════════════════════════════════════════════

// Structured Outputs 용 스키마. strict 모드는 모든 필드가 required 이고
// additionalProperties: false 여야 한다.
const AI_RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    name:       { type: 'string', description: '요리 이름 (한국어, 20자 이내)' },
    emoji:      { type: 'string', description: '요리를 대표하는 이모지 1개' },
    minutes:    { type: 'integer', description: '총 조리 시간(분)' },
    difficulty: { type: 'string', enum: ['쉬움', '보통', '어려움'] },
    servings:   { type: 'integer', description: '몇 인분인지' },
    summary:    { type: 'string', description: '요리를 한 문장으로 소개' },
    tags:       { type: 'array', items: { type: 'string' }, description: '해시태그 2~3개 (# 제외)' },
    ingredients: {
      type: 'array',
      description: '필요한 재료 목록',
      items: {
        type: 'object',
        properties: {
          name:   { type: 'string', description: '재료 이름만 (예: 계란)' },
          amount: { type: 'string', description: '분량 (예: 3개, 200g)' },
        },
        required: ['name', 'amount'],
        additionalProperties: false,
      },
    },
    steps: { type: 'array', items: { type: 'string' }, description: '조리 순서, 한 단계씩' },
  },
  required: ['name', 'emoji', 'minutes', 'difficulty', 'servings', 'summary', 'tags', 'ingredients', 'steps'],
  additionalProperties: false,
};

/** OpenAI 에 레시피 생성을 요청하고 JSON 으로 돌려받는다. */
async function requestRecipeFromAI({ ingredientNames, request }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  const owned = ingredientNames.length > 0
    ? `사용자의 냉장고에 있는 재료: ${ingredientNames.join(', ')}`
    : '사용자의 냉장고 재료 정보는 없습니다.';

  const wish = request
    ? `사용자의 추가 요청: ${request}`
    : '추가 요청은 없습니다. 무난하고 실패 없는 요리를 제안하세요.';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.8,
        messages: [
          {
            role: 'system',
            content: [
              '당신은 한국 가정식에 능숙한 요리사입니다. 실제로 만들 수 있는 레시피만 제안합니다.',
              '모든 내용은 한국어로 작성합니다.',
              '재료 이름은 "계란", "대파"처럼 재료명만 쓰고 분량은 amount 에 따로 적습니다.',
              '냉장고에 있는 재료를 최대한 활용하되, 꼭 필요하면 흔한 재료를 추가해도 됩니다.',
              '조리 순서는 4~6단계로, 한 단계에 하나의 동작만 적습니다.',
            ].join('\n'),
          },
          { role: 'user', content: `${owned}\n${wish}\n\n이 조건으로 레시피 하나를 만들어 주세요.` },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'recipe', strict: true, schema: AI_RECIPE_SCHEMA },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('[openai]', res.status, detail.slice(0, 500));

      if (res.status === 401) throw new Error('OpenAI 인증에 실패했습니다. API 키를 확인해 주세요.');
      if (res.status === 429) throw new Error('OpenAI 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.');
      throw new Error('AI 레시피 생성에 실패했습니다.');
    }

    const body = await res.json();
    const content = body.choices?.[0]?.message?.content;

    if (!content) throw new Error('AI 응답이 비어 있습니다.');

    return JSON.parse(content);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('AI 응답이 너무 오래 걸려 취소했습니다.');
    if (err instanceof SyntaxError) throw new Error('AI 응답을 해석하지 못했습니다.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** AI 응답을 DB 에 넣기 전에 다듬는다. 모델이 범위를 벗어난 값을 줄 수 있다. */
function normalizeAIRecipe(raw) {
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const int = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  const ingredients = (Array.isArray(raw.ingredients) ? raw.ingredients : [])
    .filter((it) => it && text(it.name, 50))
    .slice(0, 20)
    .map((it) => ({ name: text(it.name, 50), amount: text(it.amount, 50) || '적당량' }));

  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s) => text(s, 300))
    .filter(Boolean)
    .slice(0, 12);

  const name = text(raw.name, 60);

  if (!name || ingredients.length === 0 || steps.length === 0) {
    throw new Error('AI가 만든 레시피에 빠진 항목이 있어 저장하지 못했습니다.');
  }

  return {
    name,
    emoji: text(raw.emoji, 8) || '🍽',
    minutes: int(raw.minutes, 1, 600, 20),
    difficulty: ['쉬움', '보통', '어려움'].includes(raw.difficulty) ? raw.difficulty : '보통',
    servings: int(raw.servings, 1, 12, 2),
    summary: text(raw.summary, 200),
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((t) => text(t, 20).replace(/^#/, ''))
      .filter(Boolean)
      .slice(0, 4),
    ingredients,
    steps,
  };
}

app.post('/api/recipes/generate', async (req, res, next) => {
  const client = await pool.connect();

  try {
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ success: false, message: 'OPENAI_API_KEY 가 설정되지 않았습니다.' });
    }

    const { useFridge = true, request = '' } = req.body || {};

    if (typeof request !== 'string' || request.length > 300) {
      return res.status(400).json({ success: false, message: '요청사항은 300자 이내의 문자열이어야 합니다.' });
    }

    // 냉장고 재료는 클라이언트가 아니라 DB 에서 직접 읽는다.
    let ingredientNames = [];
    if (useFridge) {
      const { rows } = await client.query('SELECT name FROM fridge_ingredients ORDER BY expiry ASC');
      ingredientNames = rows.map((r) => r.name);
    }

    const generated = normalizeAIRecipe(
      await requestRecipeFromAI({ ingredientNames, request: request.trim() }),
    );

    // 레시피와 재료를 한 트랜잭션으로 저장 — 중간에 실패하면 둘 다 롤백된다.
    await client.query('BEGIN');

    const { rows: [created] } = await client.query(
      `INSERT INTO fridge_recipes (name, emoji, minutes, difficulty, servings, summary, tags, steps, is_ai)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING id`,
      [
        generated.name, generated.emoji, generated.minutes, generated.difficulty,
        generated.servings, generated.summary, generated.tags, generated.steps,
      ],
    );

    for (let i = 0; i < generated.ingredients.length; i += 1) {
      const ri = generated.ingredients[i];
      await client.query(
        'INSERT INTO fridge_recipe_ingredients (recipe_id, name, amount, sort_order) VALUES ($1, $2, $3, $4)',
        [created.id, ri.name, ri.amount, i],
      );
    }

    await client.query('COMMIT');

    const { rows } = await pool.query(`${RECIPE_SELECT} WHERE r.id = $1 GROUP BY r.id`, [created.id]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    // AI 호출 실패는 서버 버그가 아니므로 사유를 그대로 알려준다.
    if (err.message && !err.code) {
      console.error('[generate]', err.message);
      return res.status(502).json({ success: false, message: err.message });
    }

    next(err);
  } finally {
    client.release();
  }
});

app.delete('/api/recipes/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }

    // 재료는 ON DELETE CASCADE 로 함께 지워진다.
    const { rowCount } = await pool.query('DELETE FROM fridge_recipes WHERE id = $1', [id]);

    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 레시피를 찾을 수 없습니다.' });
    }

    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// 즐겨찾기 토글. 지금은 is_favorite 만 수정할 수 있다.
app.patch('/api/recipes/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { is_favorite: isFavorite } = req.body || {};

    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }
    if (typeof isFavorite !== 'boolean') {
      return res.status(400).json({ success: false, message: 'is_favorite 는 true/false 여야 합니다.' });
    }

    const { rows } = await pool.query(
      'UPDATE fridge_recipes SET is_favorite = $2 WHERE id = $1 RETURNING id, is_favorite',
      [id, isFavorite],
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 레시피를 찾을 수 없습니다.' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// 요리 완료 — 사용한 재료를 차감하고 기록을 남긴다.
// 레시피 분량("1/2개", "2쪽")과 냉장고 단위가 다를 수 있어서, 얼마나 뺄지는
// 클라이언트가 재료 행(ingredientId)별로 정해서 보낸다.
// body: { uses: [{ ingredientId, amount }] }
app.post('/api/recipes/:id/cook', async (req, res, next) => {
  const id = Number(req.params.id);
  const uses = Array.isArray(req.body?.uses) ? req.body.uses : [];

  if (!Number.isInteger(id)) {
    return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
  }

  const parsed = uses.map((u) => ({ ingredientId: Number(u?.ingredientId), amount: Number(u?.amount) }));

  if (parsed.some((u) => !Number.isInteger(u.ingredientId) || !Number.isFinite(u.amount) || u.amount <= 0)) {
    return res.status(400).json({ success: false, message: '차감할 재료 정보(uses)가 올바르지 않습니다.' });
  }

  // 같은 재료 행이 여러 번 오면 합쳐서 한 번에 뺀다.
  const amountById = new Map();
  for (const u of parsed) amountById.set(u.ingredientId, (amountById.get(u.ingredientId) || 0) + u.amount);
  const ingredientIds = [...amountById.keys()];

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 레시피 존재 확인과 기록을 한 문장으로 — 넣은 행이 없으면 없는 레시피다.
    const { rowCount } = await client.query(
      'INSERT INTO fridge_cook_logs (recipe_id, recipe_name) SELECT id, name FROM fridge_recipes WHERE id = $1',
      [id],
    );

    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: '해당 레시피를 찾을 수 없습니다.' });
    }

    // 그 사이 지워진 재료는 UPDATE 대상에서 자연히 빠진다.
    const { rows: changed } = await client.query(
      `UPDATE fridge_ingredients SET qty = GREATEST(qty - u.amount, 0)
       FROM unnest($1::int[], $2::numeric[]) AS u(ingredient_id, amount)
       WHERE id = u.ingredient_id
       RETURNING ${INGREDIENT_COLUMNS}`,
      [ingredientIds, [...amountById.values()]],
    );

    // 다 쓴 재료는 냉장고에서 뺀다.
    const { rows: deleted } = await client.query(
      'DELETE FROM fridge_ingredients WHERE id = ANY($1::int[]) AND qty <= 0 RETURNING id',
      [ingredientIds],
    );

    // 요리 횟수·마지막 날짜는 목록과 같은 RECIPE_SELECT 로 다시 읽는다.
    const { rows: [recipe] } = await client.query(`${RECIPE_SELECT} WHERE r.id = $1 GROUP BY r.id`, [id]);

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: { updated: changed.filter((row) => row.qty > 0), deleted: deleted.map((row) => row.id), recipe },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════
// 🛒 장보기 (shopping)
// ════════════════════════════════════════════════════════════
app.get('/api/shopping', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, checked FROM fridge_shopping_items ORDER BY checked ASC, id ASC',
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// 단건(name) 과 여러건(names) 을 모두 받는다. 이미 있는 이름은 건너뛴다.
app.post('/api/shopping', async (req, res, next) => {
  try {
    const { name, names } = req.body || {};
    const list = (Array.isArray(names) ? names : [name])
      .filter((n) => typeof n === 'string' && n.trim())
      .map((n) => n.trim());

    if (list.length === 0) {
      return res.status(400).json({ success: false, message: '담을 품목 이름(name 또는 names)이 필요합니다.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO fridge_shopping_items (name)
       SELECT unnest($1::text[])
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name, checked`,
      [list],
    );

    res.status(201).json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// 구매한 항목을 냉장고 재료로 옮긴다. 이름은 장보기 항목에서 가져오고,
// 나머지(수량·분류·유통기한 등)는 클라이언트가 항목별로 보낸다.
// body: { items: [{ id, qty, unit, category, place, expiry }] }
app.post('/api/shopping/to-fridge', async (req, res, next) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const ids = items.map((it) => Number(it?.id));

  if (items.length === 0 || ids.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ success: false, message: '냉장고로 옮길 항목(items)과 각 id 가 필요합니다.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 장보기에서 먼저 지우고, 실제로 지워진 항목만 입고한다.
    // 버튼을 두 번 눌러도 두 번째 요청은 지울 게 없어 중복 입고되지 않는다.
    const { rows: removed } = await client.query(
      'DELETE FROM fridge_shopping_items WHERE id = ANY($1::int[]) RETURNING id, name',
      [ids],
    );
    const nameById = new Map(removed.map((r) => [r.id, r.name]));

    const toInsert = [];

    for (const it of items) {
      const id = Number(it.id);
      const name = nameById.get(id);
      if (!name) continue;
      nameById.delete(id);   // 같은 id 가 여러 번 와도 한 번만 넣는다

      const { values, error } = parseIngredientFields({ ...it, name });

      if (error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `${name}: ${error}` });
      }

      toInsert.push(values);
    }

    const created = await insertIngredients(client, toInsert);

    await client.query('COMMIT');

    res.status(201).json({ success: true, data: { ingredients: created, removed: removed.map((r) => r.id) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ⚠️ '/checked' 는 '/:id' 보다 먼저 등록해야 id 라우트에 가로채이지 않는다.
app.delete('/api/shopping/checked', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM fridge_shopping_items WHERE checked = true RETURNING id',
    );
    res.json({ success: true, data: { deleted: rows.map((r) => r.id) } });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/shopping/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { checked } = req.body || {};

    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }
    if (typeof checked !== 'boolean') {
      return res.status(400).json({ success: false, message: 'checked 는 true/false 여야 합니다.' });
    }

    const { rows } = await pool.query(
      'UPDATE fridge_shopping_items SET checked = $2 WHERE id = $1 RETURNING id, name, checked',
      [id, checked],
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 항목을 찾을 수 없습니다.' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/shopping/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }

    const { rowCount } = await pool.query('DELETE FROM fridge_shopping_items WHERE id = $1', [id]);

    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 항목을 찾을 수 없습니다.' });
    }

    res.json({ success: true, data: { id } });
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
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
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
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      initDB()
        .then(() => console.log('[db] 준비 완료'))
        .catch((err) => console.error('[db] 초기화 실패:', err.message));
    });
  }
}

module.exports = app;
