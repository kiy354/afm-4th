const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { get, put } = require('@vercel/blob');
const DINNER = require('./meals.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ───────────────────────────────────
// Vercel 환경변수에 끝 개행이 붙는 경우가 있어 항상 trim
const env = (name) => (process.env[name] || '').trim();
const KAKAO_KEY = () => env('KAKAO_REST_API_KEY');
const KAKAO_SECRET = () => env('KAKAO_CLIENT_SECRET');
const ADMIN_KEY = () => env('ADMIN_KEY');
const CRON_SECRET = () => env('CRON_SECRET');
const USE_BLOB = () => Boolean(env('BLOB_READ_WRITE_TOKEN'));

const STATE_PATH = 'state.json';
const PLACES = ['냉장', '냉동', '실온'];
const emptyState = () => ({ fridge: [], nextId: 1, kakao: null, lastSent: null, lastError: null });

// ── State store (Vercel Blob 비공개 저장소, 토큰이 없으면 인메모리) ──
// 서버리스 인스턴스는 요청 사이에 메모리를 잃으므로 배포 환경에서는 Blob 에 저장한다.
let memoryState = emptyState();

async function loadState() {
  if (!USE_BLOB()) return { state: structuredClone(memoryState), etag: null };
  const res = await get(STATE_PATH, { access: 'private', useCache: false }).catch((err) => {
    if (err && err.name === 'BlobNotFoundError') return null;
    throw err;
  });
  if (!res || res.statusCode !== 200) return { state: emptyState(), etag: null };
  const text = await new Response(res.stream).text();
  return { state: { ...emptyState(), ...JSON.parse(text) }, etag: res.blob.etag };
}

async function saveState(state, etag) {
  if (!USE_BLOB()) { memoryState = structuredClone(state); return; }
  await put(STATE_PATH, JSON.stringify(state), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
    ...(etag ? { ifMatch: etag } : {}),
  });
}

// 읽기 → 수정 → 저장. 동시에 다른 요청이 저장했으면(ETag 불일치) 다시 시도한다.
async function updateState(mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, etag } = await loadState();
    const result = mutate(state);
    try {
      await saveState(state, etag);
      return result;
    } catch (err) {
      if (err && err.name === 'BlobPreconditionFailedError' && attempt < 2) continue;
      throw err;
    }
  }
}

// ── Helpers ──────────────────────────────────
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function cleanItem(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw badRequest('재료 이름을 입력해 주세요.');
    if (name.length > 40) throw badRequest('재료 이름은 40자 이하로 입력해 주세요.');
    out.name = name;
  }
  if (!partial || body.qty !== undefined) out.qty = String(body.qty || '').trim().slice(0, 30);
  if (!partial || body.place !== undefined) {
    const place = body.place || (out.name ? DINNER.guessPlace(out.name) : '냉장');
    if (!PLACES.includes(place)) throw badRequest(`보관 장소는 ${PLACES.join(', ')} 중 하나여야 합니다.`);
    out.place = place;
  }
  if (!partial || body.expires !== undefined) {
    const expires = body.expires || '';
    if (expires && !isDate(expires)) throw badRequest('유통기한은 YYYY-MM-DD 형식이어야 합니다.');
    out.expires = expires;
  }
  return out;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function baseUrl(req) {
  if (req) return `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
  const prod = env('VERCEL_PROJECT_PRODUCTION_URL');
  return prod ? `https://${prod}` : `http://localhost:${PORT}`;
}

function shoppingSummary(date, fridge) {
  const meal = DINNER.MEALS.find((m) => m.date === date);
  if (!meal) return { date, meal: null, need: [], have: [] };
  const { need, have } = DINNER.shoppingFor(meal, fridge);
  return { date, meal: { date: meal.date, title: meal.title, time: meal.time }, need, have };
}

// 비교용 ID 비교 (타이밍 공격 방지)
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY()) return res.status(500).json({ success: false, message: 'ADMIN_KEY 환경변수가 설정되지 않았습니다.' });
  const key = req.get('x-admin-key') || req.query.key;
  if (!safeEqual(key, ADMIN_KEY())) return res.status(401).json({ success: false, message: '관리 키가 올바르지 않습니다.' });
  next();
}

// ── Kakao ────────────────────────────────────
async function kakaoToken(params) {
  const body = new URLSearchParams({ client_id: KAKAO_KEY(), ...params });
  if (KAKAO_SECRET()) body.set('client_secret', KAKAO_SECRET());
  const r = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`카카오 토큰 오류: ${data.error_description || data.error || r.status}`);
  return data;
}

function mergeToken(prev, data) {
  const now = Date.now();
  return {
    access_token: data.access_token,
    expires_at: now + (data.expires_in || 0) * 1000,
    refresh_token: data.refresh_token || prev?.refresh_token,
    refresh_expires_at: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : prev?.refresh_expires_at,
  };
}

// 만료 5분 전이면 refresh_token 으로 새 access_token 을 받아 저장한다
async function validAccessToken() {
  const { state } = await loadState();
  const k = state.kakao;
  if (!k) throw new Error('카카오가 아직 연결되지 않았습니다.');
  if (k.expires_at - Date.now() > 5 * 60 * 1000) return k.access_token;
  const data = await kakaoToken({ grant_type: 'refresh_token', refresh_token: k.refresh_token });
  const next = await updateState((s) => (s.kakao = mergeToken(s.kakao, data)));
  return next.access_token;
}

function buildMessage(summary) {
  const d = summary.date.slice(5).replace('-', '/');
  if (!summary.meal) return null;
  const head = `🛒 ${d} 장보기\n저녁: ${summary.meal.title}\n\n`;
  if (summary.need.length === 0) return `${head}냉장고에 재료가 다 있어요. 오늘은 장 안 봐도 돼요!`;
  let body = `사야 할 것 ${summary.need.length}가지\n`;
  const names = summary.need.map((n) => n.name);
  // 카카오 텍스트 템플릿은 200자 제한
  for (let i = 0; i < names.length; i++) {
    const rest = names.length - i - 1;
    const line = `· ${names[i]}\n`;
    const tail = rest > 0 ? `외 ${rest}가지` : '';
    if ((head + body + line + tail).length > 195) { body += `외 ${names.length - i}가지`; return head + body; }
    body += line;
  }
  return (head + body).trim();
}

async function sendKakaoMemo(text, link) {
  const token = await validAccessToken();
  const template = { object_type: 'text', text, link: { web_url: link, mobile_web_url: link }, button_title: '냉장고 앱 열기' };
  const r = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.result_code !== 0) throw new Error(`카카오 메시지 전송 실패: ${data.msg || r.status}`);
}

async function sendDailyShopping(req) {
  const { state } = await loadState();
  const summary = shoppingSummary(DINNER.todayKST(), state.fridge);
  const text = buildMessage(summary);
  if (!text) return { sent: false, reason: '오늘은 식단이 없습니다.' };
  await sendKakaoMemo(text, `${baseUrl(req)}/fridge.html#/shopping`);
  await updateState((s) => {
    s.lastSent = { at: new Date().toISOString(), date: summary.date, count: summary.need.length };
    s.lastError = null;
  });
  return { sent: true, text };
}

// 자동 발송이 실패하면 알림 화면에서 볼 수 있게 남긴다
async function recordError(err) {
  await updateState((s) => (s.lastError = { at: new Date().toISOString(), message: err.message })).catch(() => {});
}

// ── Middleware ───────────────────────────────
app.use(express.json());

// 공개 파일만 내보낸다. express.static(__dirname) 은 server.js·package.json 까지 노출하므로 쓰지 않는다.
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/fridge': 'fridge.html', '/fridge.html': 'fridge.html', '/meals.js': 'meals.js' };
app.get(Object.keys(PUBLIC_FILES), (req, res) => res.sendFile(path.join(__dirname, PUBLIC_FILES[req.path])));

// ── API: 냉장고 ──────────────────────────────
app.get('/api/fridge', wrap(async (_req, res) => {
  const { state } = await loadState();
  res.json({ success: true, data: state.fridge });
}));

app.post('/api/fridge', wrap(async (req, res) => {
  const fields = cleanItem(req.body || {});
  const item = await updateState((s) => {
    const it = { id: s.nextId++, ...fields, addedAt: new Date().toISOString() };
    s.fridge.push(it);
    return it;
  });
  res.status(201).json({ success: true, data: item });
}));

// 장 본 재료를 한 번에 넣기: { names: ['대파', '두부'] }
app.post('/api/fridge/bulk', wrap(async (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : null;
  if (!names || names.length === 0 || names.length > 50) throw badRequest('names 배열(1~50개)이 필요합니다.');
  const fields = names.map((name) => cleanItem({ name }));
  const added = await updateState((s) => fields.map((f) => {
    const it = { id: s.nextId++, ...f, addedAt: new Date().toISOString() };
    s.fridge.push(it);
    return it;
  }));
  res.status(201).json({ success: true, data: added });
}));

app.patch('/api/fridge/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const fields = cleanItem(req.body || {}, true);
  const item = await updateState((s) => {
    const it = s.fridge.find((f) => f.id === id);
    if (it) Object.assign(it, fields);
    return it;
  });
  if (!item) return res.status(404).json({ success: false, message: '해당 재료를 찾을 수 없습니다.' });
  res.json({ success: true, data: item });
}));

app.delete('/api/fridge/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const removed = await updateState((s) => {
    const i = s.fridge.findIndex((f) => f.id === id);
    return i === -1 ? null : s.fridge.splice(i, 1)[0];
  });
  if (!removed) return res.status(404).json({ success: false, message: '해당 재료를 찾을 수 없습니다.' });
  res.json({ success: true, data: removed });
}));

// ── API: 장보기 ──────────────────────────────
app.get('/api/shopping', wrap(async (req, res) => {
  const date = req.query.date || DINNER.todayKST();
  if (!isDate(date)) throw badRequest('date는 YYYY-MM-DD 형식이어야 합니다.');
  const { state } = await loadState();
  res.json({ success: true, data: shoppingSummary(date, state.fridge) });
}));

// ── API: 카카오 알림 ─────────────────────────
app.get('/api/kakao/status', wrap(async (_req, res) => {
  const { state } = await loadState();
  const k = state.kakao;
  res.json({
    success: true,
    data: {
      configured: Boolean(KAKAO_KEY() && ADMIN_KEY()),
      connected: Boolean(k),
      refreshExpiresAt: k?.refresh_expires_at || null,
      lastSent: state.lastSent,
      lastError: state.lastError || null,
      storage: USE_BLOB() ? 'blob' : 'memory',
    },
  });
}));

// 1) 관리 키 확인 후 카카오 로그인 화면으로 이동
app.get('/api/kakao/login', requireAdmin, (req, res) => {
  if (!KAKAO_KEY()) return res.status(500).json({ success: false, message: 'KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.' });
  const params = new URLSearchParams({
    client_id: KAKAO_KEY(),
    redirect_uri: `${baseUrl(req)}/api/kakao/callback`,
    response_type: 'code',
    scope: 'talk_message',
    // state 에 관리 키의 해시를 실어, 콜백이 이 흐름에서 온 것인지 확인한다
    state: crypto.createHash('sha256').update(ADMIN_KEY()).digest('hex').slice(0, 32),
  });
  res.redirect(`https://kauth.kakao.com/oauth/authorize?${params}`);
});

// 2) 카카오가 돌려준 code 로 토큰을 받아 저장
app.get('/api/kakao/callback', wrap(async (req, res) => {
  const expected = crypto.createHash('sha256').update(ADMIN_KEY()).digest('hex').slice(0, 32);
  if (!ADMIN_KEY() || !safeEqual(req.query.state, expected)) {
    return res.status(401).send('잘못된 요청입니다. 냉장고 앱의 [카카오 연결] 버튼으로 다시 시도해 주세요.');
  }
  if (req.query.error || !req.query.code) return res.redirect('/fridge.html#/settings?kakao=denied');
  const data = await kakaoToken({ grant_type: 'authorization_code', redirect_uri: `${baseUrl(req)}/api/kakao/callback`, code: req.query.code });
  await updateState((s) => (s.kakao = mergeToken(null, data)));
  res.redirect('/fridge.html#/settings?kakao=ok');
}));

app.post('/api/kakao/test', requireAdmin, wrap(async (req, res) => {
  const result = await sendDailyShopping(req);
  res.json({ success: true, data: result });
}));

app.delete('/api/kakao', requireAdmin, wrap(async (_req, res) => {
  await updateState((s) => { s.kakao = null; });
  res.json({ success: true, data: null });
}));

// ── Cron: 매일 15:00~15:59 KST (06:00 UTC, Hobby 요금제는 그 1시간 안에 실행) ──
// Vercel 은 CRON_SECRET 이 설정돼 있으면 Authorization: Bearer <CRON_SECRET> 을 붙여 호출한다
app.get('/api/cron/daily', wrap(async (req, res) => {
  if (!CRON_SECRET() || !safeEqual(req.get('authorization'), `Bearer ${CRON_SECRET()}`)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const result = await sendDailyShopping(null);
    res.json({ success: true, data: result });
  } catch (err) {
    await recordError(err);
    throw err;
  }
}));

// ── Not found (Express 5 문법) ─────────────────
// 화면 이동은 해시 라우팅(/#/..., /fridge.html#/...)이라 그 밖의 경로는 모두 404
app.use('/{*splat}', (_req, res) => res.status(404).json({ success: false, message: 'Not found' }));

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'JSON 형식이 올바르지 않습니다.' });
  if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
  console.error(err);
  res.status(500).json({ success: false, message: err.message && /카카오/.test(err.message) ? err.message : '서버 오류가 발생했습니다.' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} (storage: ${USE_BLOB() ? 'Vercel Blob' : 'memory'})`));
}
module.exports = app;
