// ════════════════════════════════════════════════════════════
// 커뮤니티 — 회원가입·로그인 + 게시판 API 서버
// Express 5 + Supabase Postgres (node-postgres) + Supabase Storage + bcrypt + JWT
// 로컬: node server.js  /  Vercel: module.exports = app
//
//   POST   /api/auth/signup   → 회원가입 (가입 즉시 로그인 토큰 발급)
//   POST   /api/auth/login    → 로그인 (토큰 발급)
//   GET    /api/auth/me       → 내 정보 (Authorization: Bearer <토큰> 필요)
//
//   GET    /api/posts                 → 글 목록 (?page=1, 최신순, 댓글 수 포함)
//   GET    /api/posts/:id             → 글 + 댓글
//   POST   /api/posts                 → 글 쓰기          🔒
//   PATCH  /api/posts/:id             → 글 수정 (작성자) 🔒
//   DELETE /api/posts/:id             → 글 삭제 (작성자) 🔒
//   POST   /api/posts/:id/comments    → 댓글 쓰기        🔒
//   DELETE /api/comments/:id          → 댓글 삭제 (작성자) 🔒
//   POST   /api/uploads               → 이미지 1장 업로드 → Supabase Storage 🔒
//
//   GET    /api/health        → 헬스체크 (DB 연결 포함)
//   🔒 = Authorization: Bearer <토큰> 필요. 읽기는 비회원도 가능.
// ════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
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
const BCRYPT_ROUNDS = 10;        // 해시 1회 ≈ 수십 ms. 무차별 대입을 느리게 만든다.
const TOKEN_TTL = '7d';
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;         // bcrypt 는 72바이트 이후를 잘라내므로 그 이상은 막는다.
const NICKNAME_MIN = 2;
const NICKNAME_MAX = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TITLE_MAX = 100;
const CONTENT_MAX = 5000;
const COMMENT_MAX = 1000;
const PAGE_SIZE = 10;
const MAX_IMAGES = 4;                   // 글 하나에 붙일 수 있는 이미지 수
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Vercel 함수 요청 본문 한도(4.5MB)보다 작게

// ── Supabase Storage ─────────────────────────────────────────
// 이미지 파일은 DB 가 아니라 Storage(파일 저장소)에 두고, DB 에는 파일 경로만 저장한다.
// SUPABASE_URL 이 없으면 DATABASE_URL 의 사용자명(postgres.<프로젝트ref>)에서 주소를 만든다.
function supabaseUrlFromDb() {
  try {
    const ref = new URL((process.env.DATABASE_URL || '').trim()).username.split('.')[1];
    return ref ? `https://${ref}.supabase.co` : '';
  } catch { return ''; }
}
const SUPABASE_URL = ((process.env.SUPABASE_URL || '').trim() || supabaseUrlFromDb()).replace(/\/$/, '');
// service_role 키는 RLS 를 무시하는 관리자 키 — 서버에만 두고 브라우저로 절대 보내지 않는다.
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const BUCKET = 'community-images';

// 확장자는 클라이언트가 보낸 Content-Type 이 아니라 파일 앞부분의 "매직 넘버"로 판정한다.
const IMAGE_SIGNATURES = [
  { ext: 'jpg',  mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png',  mime: 'image/png',  test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'gif',  mime: 'image/gif',  test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

async function storageFetch(urlPath, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw httpError(503, '이미지 저장소가 설정되지 않았습니다. (SUPABASE_SERVICE_ROLE_KEY 필요)');
  }
  const res = await fetch(`${SUPABASE_URL}/storage/v1${urlPath}`, {
    ...init,
    headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, ...init.headers },
  });
  return res;
}

// 버킷이 없으면 공개(public) 버킷으로 만든다. 이미지 주소만 알면 누구나 볼 수 있지만,
// 올리고 지우는 건 service_role 키를 가진 이 서버만 할 수 있다.
let bucketReady = null;
function ensureBucket() {
  if (!bucketReady) {
    bucketReady = (async () => {
      const found = await storageFetch(`/bucket/${BUCKET}`);
      if (found.ok) return;
      const created = await storageFetch('/bucket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: BUCKET, name: BUCKET, public: true,
          file_size_limit: MAX_IMAGE_BYTES,
          allowed_mime_types: IMAGE_SIGNATURES.map((s) => s.mime),
        }),
      });
      // 동시에 두 요청이 만들려고 하면 한쪽은 "이미 있음"이 난다 — 그건 성공으로 본다.
      if (!created.ok && !/already exists|Duplicate/i.test(await created.text())) {
        throw new Error(`버킷 생성 실패 (${created.status})`);
      }
    })().catch((err) => { bucketReady = null; throw err; });
  }
  return bucketReady;
}

const publicImageUrl = (p) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${p}`;

// 글이 지워지거나 수정으로 빠진 이미지는 Storage 에서도 지운다.
// 실패해도 글 처리는 이미 끝났으므로 로그만 남긴다 (파일이 남는 것뿐, 데이터는 깨지지 않는다).
async function removeImages(paths) {
  if (!paths?.length) return;
  try {
    const res = await storageFetch(`/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!res.ok) console.error('[storage] 삭제 실패', res.status, await res.text());
  } catch (err) {
    console.error('[storage] 삭제 실패', err.message);
  }
}

// ── Lazy DB Init ─────────────────────────────────────────────
// 서버리스는 cold start 마다 호출될 수 있어 플래그로 중복 실행을 막는다.
let dbInitialized = false;
let initPromise = null;

async function runInit() {
  // 테이블 접두사 community_ — Supabase 한 곳을 여러 과제가 공유하므로 이름 충돌을 막는다.
  // 이메일은 소문자로 정규화해 저장하므로 UNIQUE 만으로 대소문자 중복이 막힌다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      nickname      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 회원이 지워지면 그 사람의 글·댓글도, 글이 지워지면 그 글의 댓글도 함께 지운다.
    CREATE TABLE IF NOT EXISTS community_posts (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS community_comments (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 첨부 이미지: Storage 안의 파일 경로 배열. (게시판을 먼저 만든 뒤 추가한 컬럼이라 ALTER 로 붙인다)
    ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS image_paths TEXT[] NOT NULL DEFAULT '{}';

    -- 목록은 최신순, 댓글은 글 단위로 모아 읽는다.
    CREATE INDEX IF NOT EXISTS community_posts_created_at_idx ON community_posts (created_at DESC);
    CREATE INDEX IF NOT EXISTS community_comments_post_id_idx ON community_comments (post_id);
  `);
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
  return { id: row.id, email: row.email, nickname: row.nickname, createdAt: row.created_at };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, nickname: user.nickname }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function validateSignup(body) {
  const email = String(body?.email ?? '').trim().toLowerCase();
  const nickname = String(body?.nickname ?? '').trim();
  const password = String(body?.password ?? '');

  if (!EMAIL_RE.test(email)) throw httpError(400, '이메일 형식이 올바르지 않습니다.');
  if (nickname.length < NICKNAME_MIN || nickname.length > NICKNAME_MAX) {
    throw httpError(400, `닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자로 입력해 주세요.`);
  }
  if (password.length < PASSWORD_MIN) {
    throw httpError(400, `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
  }
  if (Buffer.byteLength(password) > PASSWORD_MAX) {
    throw httpError(400, '비밀번호가 너무 깁니다.');
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw httpError(400, '비밀번호에는 영문과 숫자가 모두 들어가야 합니다.');
  }
  return { email, nickname, password };
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

app.post('/api/auth/signup', async (req, res) => {
  const { email, nickname, password } = validateSignup(req.body);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const { rows: [user] } = await pool.query(
      `INSERT INTO community_users (email, nickname, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, nickname, created_at`,
      [email, nickname, passwordHash],
    );
    res.status(201).json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
  } catch (err) {
    // 미리 SELECT 로 중복을 확인하면 두 요청이 동시에 들어올 때 둘 다 통과할 수 있다.
    // UNIQUE 제약 위반(23505)을 잡아 어느 컬럼이 겹쳤는지 알려준다.
    if (err.code === '23505') {
      const field = err.constraint?.includes('nickname') ? '닉네임' : '이메일';
      throw httpError(409, `이미 사용 중인 ${field}입니다.`);
    }
    throw err;
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) throw httpError(400, '이메일과 비밀번호를 입력해 주세요.');

  const { rows: [user] } = await pool.query(
    'SELECT id, email, nickname, password_hash, created_at FROM community_users WHERE email = $1',
    [email],
  );

  // "없는 이메일"과 "틀린 비밀번호"를 같은 문구로 답한다 —
  // 구분해 주면 어떤 이메일이 가입돼 있는지 알아내는 데 쓰일 수 있다.
  const ok = user && await bcrypt.compare(password, user.password_hash);
  if (!ok) throw httpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');

  res.json({ success: true, data: { token: issueToken(user), user: publicUser(user) } });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { rows: [user] } = await pool.query(
    'SELECT id, email, nickname, created_at FROM community_users WHERE id = $1',
    [req.userId],
  );
  // 토큰은 유효하지만 회원이 삭제된 경우
  if (!user) throw httpError(401, '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.');
  res.json({ success: true, data: { user: publicUser(user) } });
});

// ── 게시판 ───────────────────────────────────────────────────
// URL 의 :id 는 문자열이므로 양의 정수인지 먼저 확인한다 ("abc" 를 그대로 쿼리에 넣으면 22P02 → 500).
function parseId(raw, label = '글') {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw httpError(404, `존재하지 않는 ${label}입니다.`);
  return id;
}

// label 은 받침으로 끝나는 말(제목·내용·댓글)만 쓴다 — 조사 '을/은'을 고정하기 위해.
function requireText(value, label, max) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label}을 입력해 주세요.`);
  if (text.length > max) throw httpError(400, `${label}은 ${max}자 이하로 입력해 주세요.`);
  return text;
}

const toPost = (r) => ({
  id: r.id, title: r.title, content: r.content,
  authorId: r.user_id, author: r.nickname,
  createdAt: r.created_at, updatedAt: r.updated_at,
  images: (r.image_paths || []).map((p) => ({ path: p, url: publicImageUrl(p) })),
  ...(r.comment_count !== undefined && { commentCount: r.comment_count }),
});

const toComment = (r) => ({
  id: r.id, content: r.content, authorId: r.user_id, author: r.nickname, createdAt: r.created_at,
});

// 수정·삭제 전에 글이 있는지, 요청한 사람이 작성자인지 확인한다.
// 클라이언트가 "내 글"이라고 보내는 값은 믿지 않고 DB 의 user_id 와 토큰의 사용자를 비교한다.
async function assertOwner(table, id, userId, label) {
  const { rows: [row] } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (!row) throw httpError(404, `존재하지 않는 ${label}입니다.`);
  if (row.user_id !== userId) throw httpError(403, `내가 쓴 ${label}만 수정·삭제할 수 있습니다.`);
  return row;
}

// 글에 붙일 이미지 경로 검증. 업로드 API 가 만든 "내 폴더"의 경로만 받는다 —
// 그렇지 않으면 남의 이미지 경로를 내 글에 붙였다가, 내 글을 지울 때 남의 파일이 지워질 수 있다.
function parseImagePaths(raw, userId) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw httpError(400, '이미지 형식이 올바르지 않습니다.');
  if (raw.length > MAX_IMAGES) throw httpError(400, `이미지는 ${MAX_IMAGES}장까지 붙일 수 있습니다.`);
  const re = new RegExp(`^posts/${userId}/[0-9a-f-]{36}\\.(jpg|png|gif|webp)$`);
  if (!raw.every((p) => typeof p === 'string' && re.test(p))) {
    throw httpError(400, '올바르지 않은 이미지가 포함되어 있습니다.');
  }
  return [...new Set(raw)];
}

app.get('/api/posts', async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  // 목록에 본문 전체는 필요 없으니 앞부분만 잘라 보낸다.
  const [{ rows }, { rows: [{ total }] }] = await Promise.all([
    pool.query(
      `SELECT p.id, p.title, LEFT(p.content, 120) AS content, p.user_id, u.nickname,
              p.created_at, p.updated_at, p.image_paths[1:1] AS image_paths,   -- 목록에는 대표 이미지 1장만
              (SELECT COUNT(*)::int FROM community_comments c WHERE c.post_id = p.id) AS comment_count
         FROM community_posts p
         JOIN community_users u ON u.id = p.user_id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, (page - 1) * PAGE_SIZE],
    ),
    pool.query('SELECT COUNT(*)::int AS total FROM community_posts'),
  ]);

  res.json({
    success: true,
    data: { posts: rows.map(toPost), page, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total },
  });
});

app.get('/api/posts/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const [{ rows: [post] }, { rows: comments }] = await Promise.all([
    pool.query(
      `SELECT p.*, u.nickname FROM community_posts p
         JOIN community_users u ON u.id = p.user_id
        WHERE p.id = $1`,
      [id],
    ),
    pool.query(
      `SELECT c.*, u.nickname FROM community_comments c
         JOIN community_users u ON u.id = c.user_id
        WHERE c.post_id = $1
        ORDER BY c.created_at, c.id`,
      [id],
    ),
  ]);
  if (!post) throw httpError(404, '존재하지 않는 글입니다.');
  res.json({ success: true, data: { post: toPost(post), comments: comments.map(toComment) } });
});

app.post('/api/posts', requireAuth, async (req, res) => {
  const title = requireText(req.body?.title, '제목', TITLE_MAX);
  const content = requireText(req.body?.content, '내용', CONTENT_MAX);
  const images = parseImagePaths(req.body?.images, req.userId);
  const { rows: [post] } = await pool.query(
    'INSERT INTO community_posts (user_id, title, content, image_paths) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.userId, title, content, images],
  );
  res.status(201).json({ success: true, data: { id: post.id } });
});

app.patch('/api/posts/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const title = requireText(req.body?.title, '제목', TITLE_MAX);
  const content = requireText(req.body?.content, '내용', CONTENT_MAX);
  const old = await assertOwner('community_posts', id, req.userId, '글');
  // images 를 안 보내면 기존 이미지를 그대로 둔다.
  const images = req.body?.images === undefined ? old.image_paths : parseImagePaths(req.body.images, req.userId);
  await pool.query(
    'UPDATE community_posts SET title = $1, content = $2, image_paths = $3, updated_at = now() WHERE id = $4',
    [title, content, images, id],
  );
  await removeImages(old.image_paths.filter((p) => !images.includes(p)));   // 수정하면서 뺀 이미지
  res.json({ success: true, data: { id } });
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  const old = await assertOwner('community_posts', id, req.userId, '글');
  await pool.query('DELETE FROM community_posts WHERE id = $1', [id]);   // 댓글은 CASCADE 로 함께 삭제
  await removeImages(old.image_paths);                                    // 파일은 DB 밖이라 직접 지운다
  res.json({ success: true, data: { id } });
});

// 이미지 1장을 받아 Storage 에 올리고 경로를 돌려준다. 글은 그 경로를 images 로 들고 저장한다.
// 요청 본문은 JSON 이 아니라 파일 바이트 그대로(Content-Type: image/*) 받는다.
app.post('/api/uploads', requireAuth,
  express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }),
  async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw httpError(400, '이미지 파일을 보내 주세요.');
    const kind = IMAGE_SIGNATURES.find((s) => s.test(buf));
    if (!kind) throw httpError(400, 'JPG·PNG·GIF·WEBP 이미지만 올릴 수 있습니다.');

    await ensureBucket();
    // 파일 이름은 서버가 정한다 — 원래 이름을 쓰면 한글·공백·중복·경로 조작(../) 문제가 생긴다.
    const filePath = `posts/${req.userId}/${randomUUID()}.${kind.ext}`;
    const up = await storageFetch(`/object/${BUCKET}/${filePath}`, {
      method: 'POST',
      headers: { 'Content-Type': kind.mime, 'Cache-Control': 'max-age=31536000' },
      body: buf,
    });
    if (!up.ok) {
      console.error('[storage] 업로드 실패', up.status, await up.text());
      throw httpError(502, '이미지를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    res.status(201).json({ success: true, data: { path: filePath, url: publicImageUrl(filePath) } });
  });

app.post('/api/posts/:id/comments', requireAuth, async (req, res) => {
  const postId = parseId(req.params.id);
  const content = requireText(req.body?.content, '댓글', COMMENT_MAX);
  try {
    const { rows: [row] } = await pool.query(
      `WITH c AS (
         INSERT INTO community_comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING *
       )
       SELECT c.*, u.nickname FROM c JOIN community_users u ON u.id = c.user_id`,
      [postId, req.userId, content],
    );
    res.status(201).json({ success: true, data: { comment: toComment(row) } });
  } catch (err) {
    // 그 사이 글이 삭제됐으면 외래 키 위반(23503)이 난다.
    if (err.code === '23503') throw httpError(404, '존재하지 않는 글입니다.');
    throw err;
  }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  const id = parseId(req.params.id, '댓글');
  await assertOwner('community_comments', id, req.userId, '댓글');
  await pool.query('DELETE FROM community_comments WHERE id = $1', [id]);
  res.json({ success: true, data: { id } });
});

app.use('/api', (_req, _res, next) => next(httpError(404, '존재하지 않는 API 입니다.')));

// ── 정적 파일 (로컬 실행용 — Vercel 은 vercel.json 이 처리) ──
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── 에러 처리 ────────────────────────────────────────────────
// Express 5 는 async 핸들러에서 던진 에러를 자동으로 여기로 넘긴다.
app.use((err, _req, res, _next) => {
  // express.json() 이 잘못된 JSON 을 만나면 status 400 의 에러를 던진다.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err.code || '-', err.message);
  // httpError() 로 직접 만든 에러는 5xx 라도 안내 문구를 그대로 보여준다 (예: 저장소 미설정 503).
  const message = err.userFacing ? err.message
    : status >= 500 ? '서버 내부 오류가 발생했습니다.'
    : err.type === 'entity.parse.failed' ? '요청 형식이 올바르지 않습니다.'
    : err.type === 'entity.too.large' ? '파일이 너무 큽니다. (최대 4MB)'
    : err.message;
  res.status(status).json({ success: false, message });
});

// ── Startup & Export ─────────────────────────────────────────
if (require.main === module) {
  if (!process.env.DATABASE_URL) console.warn('⚠ DATABASE_URL 이 없습니다. .env 를 확인하세요.');
  if (!JWT_SECRET) console.warn('⚠ JWT_SECRET 이 없습니다. .env 를 확인하세요.');
  app.listen(PORT, () => {
    console.log(`커뮤니티 → http://localhost:${PORT}`);
    initDB()
      .then(() => console.log('[db] 준비 완료 (community_users)'))
      .catch((err) => console.error('[db] 초기화 실패:', err.message));
  });
}

module.exports = app;
