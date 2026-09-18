// ============================================================
// 밸런스 게임 서버
// ------------------------------------------------------------
// public/index.html 을 서빙하고, 질문과 투표를 Supabase(PostgreSQL) 의
// balance_questions / balance_votes 테이블에 저장한다.
// 접속 정보는 .env 의 DATABASE_URL.
//
//   GET    /api/questions            → 질문 목록 + 집계 + 전체 통계
//   POST   /api/questions            → 질문 등록 { title?, optionA, optionB }
//   POST   /api/questions/:id/vote   → 투표 { choice: 'A' | 'B' }
//   DELETE /api/questions/:id/vote   → 내 투표 취소
//   GET    /api/health               → 헬스체크 (DB 연결 포함)
//   그 외                             → public/ 정적 파일
//
// 투표자는 브라우저가 만든 voterId(UUID)로 구분한다. 헤더 x-voter-id 로
// 보내며, (question_id, voter_id) 유니크 제약 덕분에 한 질문당 한 표만
// 남고 다시 투표하면 선택이 바뀐다.
// ============================================================

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

// .env 의 DATABASE_URL 을 읽어 들인다. 파일이 없으면 실제 환경변수를 쓴다.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* .env 없음 — 무시 */
}

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024;

const MAX_TITLE_LENGTH = 100;
const MAX_OPTION_LENGTH = 100;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------
// 데이터베이스 (Supabase / PostgreSQL)
// ------------------------------------------------------------
// 6543 은 트랜잭션 풀러 포트라 커넥션을 적게 유지하고, Supabase 가
// 요구하는 SSL 과 환경변수 .trim() 을 적용한다.

// 접속 문자열(계정·비밀번호 포함)은 오직 이 파일 안에서만 쓰인다.
// 응답으로 내보내지 않으며, 클라이언트는 /api/* 만 호출한다.
function databaseUrl() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.error('DATABASE_URL 환경변수가 없습니다. 로컬은 .env, 배포는 Vercel 환경변수를 확인하세요.');
    throw fail('서버 설정이 완료되지 않았습니다.', 503);
  }
  return url;
}

// 풀은 첫 요청 때 만든다. 그래야 환경변수가 비었을 때 위의 명확한 오류가 먼저 난다.
let pool = null;
function db() {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('DB pool error:', err.message));
  }
  return pool;
}

// 첫 요청 때 한 번만 테이블을 만든다. 실패하면 다음 요청에서 다시 시도.
let dbReady = null;
function initDB() {
  if (!dbReady) {
    dbReady = (async () => {
      await db().query(`
        CREATE TABLE IF NOT EXISTS balance_questions (
          id         BIGSERIAL PRIMARY KEY,
          title      TEXT        NOT NULL DEFAULT '',
          option_a   TEXT        NOT NULL,
          option_b   TEXT        NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await db().query(`
        CREATE TABLE IF NOT EXISTS balance_votes (
          id          BIGSERIAL PRIMARY KEY,
          question_id BIGINT      NOT NULL REFERENCES balance_questions(id) ON DELETE CASCADE,
          voter_id    TEXT        NOT NULL,
          choice      TEXT        NOT NULL CHECK (choice IN ('A', 'B')),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (question_id, voter_id)
        )
      `);
      await db().query(
        'CREATE INDEX IF NOT EXISTS balance_votes_question_idx ON balance_votes (question_id)',
      );
    })().catch((err) => {
      dbReady = null;
      throw err;
    });
  }
  return dbReady;
}

// ------------------------------------------------------------
// 공통 헬퍼
// ------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const fail = (message, status) => Object.assign(new Error(message), { status });

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(fail('요청 본문이 너무 큽니다.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(fail('JSON 형식이 올바르지 않습니다.', 400));
      }
    });

    req.on('error', reject);
  });
}

// 제어문자를 걸러내고 앞뒤 공백을 정리한 문자열을 돌려준다.
function cleanText(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
}

function normalizeOption(value, label) {
  const text = cleanText(value);
  if (!text) throw fail(`${label} 선택지를 입력해 주세요.`, 400);
  if (text.length > MAX_OPTION_LENGTH) {
    throw fail(`선택지는 ${MAX_OPTION_LENGTH}자 이내로 입력해 주세요.`, 400);
  }
  return text;
}

// 투표자 식별자는 브라우저가 만든 UUID. 형식만 가볍게 확인한다.
function requireVoterId(req) {
  const voterId = cleanText(req.headers['x-voter-id']);
  if (!voterId || voterId.length > 64 || !/^[A-Za-z0-9-]+$/.test(voterId)) {
    throw fail('투표자 정보가 올바르지 않습니다. 새로고침 후 다시 시도해 주세요.', 400);
  }
  return voterId;
}

// 헤더가 없을 수도 있는 조회용 — 없으면 빈 문자열(= 아무 표와도 매칭되지 않음).
function optionalVoterId(req) {
  const voterId = cleanText(req.headers['x-voter-id']);
  return /^[A-Za-z0-9-]{1,64}$/.test(voterId) ? voterId : '';
}

// BIGSERIAL·COUNT 는 pg 에서 문자열로 오므로 클라이언트에는 숫자로 넘긴다.
function toQuestion(row) {
  const votesA = Number(row.votes_a);
  const votesB = Number(row.votes_b);
  return {
    id: Number(row.id),
    title: row.title,
    optionA: row.option_a,
    optionB: row.option_b,
    createdAt: row.created_at,
    votesA,
    votesB,
    totalVotes: votesA + votesB,
    myChoice: row.my_choice || null,
  };
}

// ------------------------------------------------------------
// 조회 쿼리
// ------------------------------------------------------------
// 질문 한 건과 목록이 같은 모양의 결과를 쓰도록 SELECT 를 공유한다.
// $1 = 조회한 사람의 voterId (내가 어디에 투표했는지 표시용).

const QUESTION_SELECT = `
  SELECT q.id, q.title, q.option_a, q.option_b, q.created_at,
         COUNT(v.id) FILTER (WHERE v.choice = 'A')            AS votes_a,
         COUNT(v.id) FILTER (WHERE v.choice = 'B')            AS votes_b,
         MAX(v.choice) FILTER (WHERE v.voter_id = $1)         AS my_choice
    FROM balance_questions q
    LEFT JOIN balance_votes v ON v.question_id = q.id
`;

async function fetchQuestions(voterId) {
  const { rows } = await db().query(
    `${QUESTION_SELECT} GROUP BY q.id ORDER BY q.id DESC`,
    [voterId],
  );
  return rows.map(toQuestion);
}

async function fetchQuestion(voterId, id) {
  const { rows } = await db().query(
    `${QUESTION_SELECT} WHERE q.id = $2 GROUP BY q.id`,
    [voterId, id],
  );
  if (rows.length === 0) throw fail('질문을 찾을 수 없습니다.', 404);
  return toQuestion(rows[0]);
}

// 전체 통계 — 총 참여자 수는 중복 없이 센 투표자 수.
async function fetchStats() {
  const { rows } = await db().query(`
    SELECT (SELECT COUNT(*) FROM balance_questions)         AS question_count,
           (SELECT COUNT(*) FROM balance_votes)             AS vote_count,
           (SELECT COUNT(DISTINCT voter_id) FROM balance_votes) AS participant_count
  `);
  return {
    questionCount: Number(rows[0].question_count),
    voteCount: Number(rows[0].vote_count),
    participantCount: Number(rows[0].participant_count),
  };
}

// ------------------------------------------------------------
// API 핸들러
// ------------------------------------------------------------

async function listQuestions(req, res) {
  const voterId = optionalVoterId(req);
  const [questions, stats] = await Promise.all([fetchQuestions(voterId), fetchStats()]);
  return sendJson(res, 200, { success: true, data: { questions, stats } });
}

async function createQuestion(req, res) {
  const voterId = optionalVoterId(req);
  const body = await readJsonBody(req);

  const title = cleanText(body.title);
  if (title.length > MAX_TITLE_LENGTH) {
    throw fail(`제목은 ${MAX_TITLE_LENGTH}자 이내로 입력해 주세요.`, 400);
  }
  const optionA = normalizeOption(body.optionA, '첫 번째');
  const optionB = normalizeOption(body.optionB, '두 번째');
  if (optionA === optionB) throw fail('두 선택지를 다르게 입력해 주세요.', 400);

  const { rows } = await db().query(
    'INSERT INTO balance_questions (title, option_a, option_b) VALUES ($1, $2, $3) RETURNING id',
    [title, optionA, optionB],
  );

  const [question, stats] = await Promise.all([
    fetchQuestion(voterId, Number(rows[0].id)),
    fetchStats(),
  ]);
  return sendJson(res, 201, { success: true, data: { question, stats } });
}

async function vote(req, res, id) {
  const voterId = requireVoterId(req);
  const { choice } = await readJsonBody(req);
  if (choice !== 'A' && choice !== 'B') throw fail("choice 는 'A' 또는 'B' 여야 합니다.", 400);

  // 같은 사람이 다시 투표하면 새 표가 아니라 선택이 바뀐다.
  const { rowCount } = await db()
    .query(
      `INSERT INTO balance_votes (question_id, voter_id, choice)
       VALUES ($1, $2, $3)
       ON CONFLICT (question_id, voter_id)
       DO UPDATE SET choice = EXCLUDED.choice, updated_at = now()`,
      [id, voterId, choice],
    )
    .catch((err) => {
      // 23503 = 외래키 위반 → 그 사이 삭제됐거나 없는 질문에 투표한 경우.
      if (err.code === '23503') throw fail('질문을 찾을 수 없습니다.', 404);
      throw err;
    });
  if (rowCount === 0) throw fail('투표를 저장하지 못했습니다.', 500);

  const [question, stats] = await Promise.all([fetchQuestion(voterId, id), fetchStats()]);
  return sendJson(res, 200, { success: true, data: { question, stats } });
}

async function cancelVote(req, res, id) {
  const voterId = requireVoterId(req);
  const { rowCount } = await db().query(
    'DELETE FROM balance_votes WHERE question_id = $1 AND voter_id = $2',
    [id, voterId],
  );
  if (rowCount === 0) throw fail('취소할 투표가 없습니다.', 404);

  const [question, stats] = await Promise.all([fetchQuestion(voterId, id), fetchStats()]);
  return sendJson(res, 200, { success: true, data: { question, stats } });
}

// ------------------------------------------------------------
// 정적 파일 서빙 (public/)
// ------------------------------------------------------------

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // 경로 탈출(../) 차단
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { success: false, message: 'Forbidden' });
  }

  try {
    const file = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 수업 중 파일을 고치면 새로고침만으로 바로 반영되도록 캐시를 끈다.
      'Cache-Control': 'no-cache',
    });
    res.end(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    throw err;
  }
}

// ------------------------------------------------------------
// 라우팅
// ------------------------------------------------------------

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/health') {
      try {
        await initDB();
        await db().query('SELECT 1');
        return sendJson(res, 200, { success: true, data: { status: 'ok', db: 'connected' } });
      } catch (err) {
        // 원인(호스트·계정명 등)은 서버 로그에만 남긴다. 응답에 실으면
        // 접속 정보 일부가 브라우저로 새어 나간다.
        console.error('health check 실패:', err.message);
        return sendJson(res, 503, { success: false, message: 'DB에 연결할 수 없습니다.', data: { db: 'disconnected' } });
      }
    }

    if (pathname === '/api/questions') {
      await initDB();
      if (req.method === 'GET') return await listQuestions(req, res);
      if (req.method === 'POST') return await createQuestion(req, res);
      res.writeHead(405, { Allow: 'GET, POST' });
      return res.end();
    }

    const voteMatch = pathname.match(/^\/api\/questions\/(\d+)\/vote$/);
    if (voteMatch) {
      await initDB();
      const id = Number(voteMatch[1]);
      if (req.method === 'POST') return await vote(req, res, id);
      if (req.method === 'DELETE') return await cancelVote(req, res, id);
      res.writeHead(405, { Allow: 'POST, DELETE' });
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { success: false, message: 'API를 찾을 수 없습니다.' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    return await serveStatic(pathname, res);
  } catch (err) {
    if (res.writableEnded) return;
    // pg 에러코드는 5자리 SQLSTATE — DB 문제는 503 으로 구분한다.
    const status = err.status || (err.code && String(err.code).length === 5 ? 503 : 500);
    if (status >= 500) console.error(err);
    const message = status === 503
      ? '데이터베이스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
      : status >= 500 ? '서버 오류가 발생했습니다.' : err.message;
    sendJson(res, status, { success: false, message });
  }
}

// 로컬에서 `node server.js` 로 직접 실행할 때만 포트를 연다.
// Vercel 에서는 api/[...path].js 가 이 핸들러만 가져다 쓴다(서버리스라 listen 불필요).
if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠ DATABASE_URL 이 없습니다. .env 파일을 확인하세요 (.env.example 참고).');
  }
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`밸런스 게임   → http://localhost:${PORT}`);
    console.log('저장소        → Supabase PostgreSQL (balance_questions / balance_votes)');
  });
}

module.exports = handleRequest;
