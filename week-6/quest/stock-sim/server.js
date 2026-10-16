// ════════════════════════════════════════════════════════════
// 모의투자 리서치 — API 서버
// Express 5 + Supabase Postgres + Yahoo Finance(시세) + OpenAI(종목 분석)
// 로컬: node server.js  /  Vercel: module.exports = app
//
//   POST   /api/auth/join            → 리그 참가 (닉네임 + 비밀번호, 1,000만 원 계좌 생성)
//   POST   /api/auth/login           → 로그인
//   GET    /api/me                   → 내 정보                      🔒
//
//   GET    /api/league               → 리그 현황판 (순위·최근 체결·인기 보유 종목)
//   GET    /api/league/players/:id   → 참가자 상세 (보유 종목·거래 내역 공개)
//
//   GET    /api/search?q=            → 종목 검색 (한글 별칭 + Yahoo 검색)
//   GET    /api/popular              → 인기 종목 시세
//   GET    /api/stocks/:symbol       → 시세 + 차트 (?range=) — 로그인 상태면 내 보유·관심 여부 포함
//
//   GET    /api/portfolio            → 내 계좌 요약 + 보유 종목      🔒
//   POST   /api/trades               → 매수/매도 { symbol, side, qty } 🔒
//   GET    /api/trades               → 내 거래 내역 (?symbol=)       🔒
//   POST   /api/account/reset        → 내 계좌 초기화 (리셋 횟수 공개) 🔒
//   GET    /api/watchlist            → 관심 종목                    🔒
//   POST   /api/watchlist            → 관심 종목 추가 { symbol }     🔒
//   DELETE /api/watchlist/:symbol    → 관심 종목 삭제               🔒
//
//   GET    /api/research             → AI 리서치 기록 (?symbol=) — 모두 공유
//   POST   /api/research             → AI 리서치 생성 { symbol }     🔒
//   GET    /api/health               → 헬스체크
//
//   🔒 = Authorization: Bearer <토큰> 필요
//
// 계좌는 원화(KRW) 하나. 미국 주식은 체결 시점의 USD/KRW 환율로 환산한다.
// ════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();

// ── DB Pool ──────────────────────────────────────────────────
// Supabase Transaction Pooler(6543). 환경변수에 개행이 섞이는 경우가 있어 .trim() 한다.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});
pool.on('error', (err) => console.error('[pg pool error]', err.message));

// ── 상수 ─────────────────────────────────────────────────────
const INITIAL_CASH = 10_000_000;          // 시작 자금 1,000만 원
const FEE_RATE = 0.00015;                 // 수수료 0.015% (매수·매도 모두)
const MAX_QTY = 100_000;
const SYMBOL_RE = /^[A-Z0-9.\-=^]{1,20}$/;
const NICKNAME_RE = /^[0-9A-Za-z가-힣_]{2,12}$/;
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 72;                  // bcrypt 는 72바이트 이후를 잘라내므로 그 이상은 막는다.
const BCRYPT_ROUNDS = 10;
const TOKEN_TTL = '30d';
const RANGES = {                          // 화면의 기간 버튼 → Yahoo 파라미터
  '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1wk', '5y': '1mo',
};
const QUOTE_TTL = 30_000;                 // 시세 캐시 30초
const FX_TTL = 10 * 60_000;               // 환율 캐시 10분
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Yahoo 검색은 한글을 받지 않는다("Invalid Search Query").
// 자주 찾는 종목은 한글 이름 → 심볼 표를 서버에 두고 먼저 찾는다.
const KR_ALIASES = [
  ['삼성전자', '005930.KS'], ['SK하이닉스', '000660.KS'], ['LG에너지솔루션', '373220.KS'],
  ['삼성바이오로직스', '207940.KS'], ['현대차', '005380.KS'], ['현대자동차', '005380.KS'],
  ['기아', '000270.KS'], ['셀트리온', '068270.KS'], ['NAVER', '035420.KS'], ['네이버', '035420.KS'],
  ['카카오', '035720.KS'], ['POSCO홀딩스', '005490.KS'], ['포스코홀딩스', '005490.KS'],
  ['KB금융', '105560.KS'], ['신한지주', '055550.KS'], ['삼성SDI', '006400.KS'],
  ['LG화학', '051910.KS'], ['삼성물산', '028260.KS'], ['한화에어로스페이스', '012450.KS'],
  ['HD현대중공업', '329180.KS'], ['카카오뱅크', '323410.KS'], ['크래프톤', '259960.KS'],
  ['엔씨소프트', '036570.KS'], ['하이브', '352820.KS'], ['LG전자', '066570.KS'],
  ['SK텔레콤', '017670.KS'], ['KT', '030200.KS'], ['삼성전기', '009150.KS'],
  ['에코프로', '086520.KQ'], ['에코프로비엠', '247540.KQ'], ['알테오젠', '196170.KQ'],
  ['펄어비스', '263750.KQ'], ['HLB', '028300.KQ'],
  ['애플', 'AAPL'], ['마이크로소프트', 'MSFT'], ['엔비디아', 'NVDA'], ['테슬라', 'TSLA'],
  ['아마존', 'AMZN'], ['구글', 'GOOGL'], ['알파벳', 'GOOGL'], ['메타', 'META'],
  ['넷플릭스', 'NFLX'], ['브로드컴', 'AVGO'], ['AMD', 'AMD'], ['인텔', 'INTC'],
  ['TSMC', 'TSM'], ['코카콜라', 'KO'], ['디즈니', 'DIS'], ['스타벅스', 'SBUX'],
  ['팔란티어', 'PLTR'], ['코스트코', 'COST'], ['버크셔해서웨이', 'BRK-B'],
  ['S&P500 ETF', 'SPY'], ['나스닥100 ETF', 'QQQ'],
];
const KR_NAME_BY_SYMBOL = Object.fromEntries(KR_ALIASES.map(([n, s]) => [s, n]).reverse());

const POPULAR = ['005930.KS', '000660.KS', '005380.KS', '035420.KS', 'AAPL', 'NVDA', 'TSLA', 'MSFT'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ════════════════════════════════════════════════════════════
// Yahoo Finance
// ════════════════════════════════════════════════════════════
// 공식 API가 아니다. v7 quote 는 crumb 이 필요해 401 이 나므로,
// 키 없이 되는 v8 chart 응답의 meta 를 시세로 쓴다.

async function yahooGet(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new HttpError(502, '시세 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (res.status === 404) throw new HttpError(404, '종목을 찾을 수 없습니다.');
  if (!res.ok) {
    console.error('[yahoo]', res.status, url);
    throw new HttpError(502, `시세 조회에 실패했습니다 (Yahoo ${res.status}).`);
  }
  return res.json();
}

const chartCache = new Map();   // key: symbol|range → { at, value }

/** 시세(meta)와 차트 포인트를 함께 가져온다. */
async function fetchChart(symbol, range = '1mo') {
  const key = `${symbol}|${range}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < QUOTE_TTL) return hit.value;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=${range}&interval=${RANGES[range]}`;
  const json = await yahooGet(url);
  const result = json?.chart?.result?.[0];
  if (!result || json.chart.error) throw new HttpError(404, '종목을 찾을 수 없습니다.');

  const m = result.meta;
  if (typeof m.regularMarketPrice !== 'number') throw new HttpError(404, '시세가 없는 종목입니다.');

  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = (result.timestamp || [])
    .map((t, i) => ({ t: t * 1000, c: closes[i] }))
    .filter((p) => typeof p.c === 'number');

  // 전일 대비: meta 에 등락률이 있으면 그것을, 없으면 이전 종가로 계산한다.
  const prevClose = typeof m.regularMarketChangePercent === 'number'
    ? m.regularMarketPrice / (1 + m.regularMarketChangePercent / 100)
    : m.chartPreviousClose;

  const value = {
    quote: {
      symbol: m.symbol,
      name: KR_NAME_BY_SYMBOL[m.symbol] || m.longName || m.shortName || m.symbol,
      englishName: m.longName || m.shortName || m.symbol,
      currency: m.currency,
      exchange: m.fullExchangeName || m.exchangeName,
      type: m.instrumentType,
      price: m.regularMarketPrice,
      prevClose,
      change: m.regularMarketPrice - prevClose,
      changePct: prevClose ? ((m.regularMarketPrice - prevClose) / prevClose) * 100 : 0,
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      high52: m.fiftyTwoWeekHigh ?? null,
      low52: m.fiftyTwoWeekLow ?? null,
      volume: m.regularMarketVolume ?? null,
      marketTime: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
    },
    points,
  };
  chartCache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchQuote(symbol) {
  return (await fetchChart(symbol, '1mo')).quote;
}

/** 여러 종목 시세. 하나가 실패해도 나머지는 돌려준다. */
async function fetchQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map(fetchQuote));
  const map = {};
  results.forEach((r, i) => { if (r.status === 'fulfilled') map[symbols[i]] = r.value; });
  return map;
}

let fxCache = null;
/** 1 단위 외화 → 원화. KRW 면 1. */
async function fxToKrw(currency) {
  if (currency === 'KRW') return 1;
  if (currency !== 'USD') throw new HttpError(400, `${currency} 표시 종목은 거래할 수 없습니다 (원화·달러만 지원).`);
  if (fxCache && Date.now() - fxCache.at < FX_TTL) return fxCache.rate;
  const json = await yahooGet('https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?range=1d&interval=1d');
  const rate = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof rate !== 'number' || rate < 500 || rate > 3000) throw new HttpError(502, '환율을 가져오지 못했습니다.');
  fxCache = { at: Date.now(), rate };
  return rate;
}

async function searchNews(symbol) {
  try {
    const json = await yahooGet(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=8`);
    return (json.news || []).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      time: n.providerPublishTime ? n.providerPublishTime * 1000 : null,
    }));
  } catch {
    return [];   // 뉴스는 없어도 분석은 진행한다.
  }
}

/** 사용자 입력 → 심볼. 소문자·공백을 정리하고 형식을 검사한다. */
function normalizeSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw new HttpError(400, '올바르지 않은 종목 코드입니다.');
  return s;
}

// ════════════════════════════════════════════════════════════
// DB 초기화 (서버리스 콜드 스타트마다 한 번만)
// ════════════════════════════════════════════════════════════
// 리그 이전의 단일 계좌 테이블(stocksim_account·holdings·trades·watchlist)은
// 데이터를 지우지 않으려고 그대로 두고, 참가자별 테이블을 새로 만든다.
let initPromise = null;

async function runInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stocksim_players (
      id            SERIAL PRIMARY KEY,
      nickname      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      cash          NUMERIC(16,2) NOT NULL CHECK (cash >= 0),
      initial_cash  NUMERIC(16,2) NOT NULL,
      reset_count   INT NOT NULL DEFAULT 0,
      joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      reset_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS stocksim_league_holdings (
      player_id    INT NOT NULL REFERENCES stocksim_players(id) ON DELETE CASCADE,
      symbol       TEXT NOT NULL,
      name         TEXT NOT NULL,
      currency     TEXT NOT NULL,
      qty          INT NOT NULL CHECK (qty > 0),
      avg_price    NUMERIC(18,4) NOT NULL,      -- 현지 통화 평균 단가
      cost_krw     NUMERIC(16,2) NOT NULL,      -- 원화 매입 원금 (수수료 포함)
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (player_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS stocksim_league_trades (
      id           SERIAL PRIMARY KEY,
      player_id    INT NOT NULL REFERENCES stocksim_players(id) ON DELETE CASCADE,
      symbol       TEXT NOT NULL,
      name         TEXT NOT NULL,
      side         TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
      qty          INT NOT NULL CHECK (qty > 0),
      price        NUMERIC(18,4) NOT NULL,
      currency     TEXT NOT NULL,
      fx_rate      NUMERIC(12,4) NOT NULL,
      amount_krw   NUMERIC(16,2) NOT NULL,      -- 체결 금액 (수수료 제외)
      fee_krw      NUMERIC(14,2) NOT NULL,
      realized_krw NUMERIC(16,2),               -- 매도 시 실현 손익
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS stocksim_league_trades_player_idx ON stocksim_league_trades(player_id, id DESC);
    CREATE TABLE IF NOT EXISTS stocksim_league_watchlist (
      player_id    INT NOT NULL REFERENCES stocksim_players(id) ON DELETE CASCADE,
      symbol       TEXT NOT NULL,
      name         TEXT NOT NULL,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (player_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS stocksim_research (
      id           SERIAL PRIMARY KEY,
      symbol       TEXT NOT NULL,
      name         TEXT NOT NULL,
      currency     TEXT NOT NULL,
      price        NUMERIC(18,4) NOT NULL,      -- 분석 시점 가격 (이후 수익률 비교용)
      outlook      TEXT NOT NULL CHECK (outlook IN ('bullish','neutral','bearish')),
      summary      TEXT NOT NULL,
      report       JSONB NOT NULL,
      model        TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS stocksim_research_symbol_idx ON stocksim_research(symbol);
    -- 리그 도입 후: 누가 분석을 요청했는지 기록 (이전 기록은 NULL)
    ALTER TABLE stocksim_research ADD COLUMN IF NOT EXISTS player_id INT REFERENCES stocksim_players(id) ON DELETE SET NULL;
  `);
}

async function initDB() {
  if (!initPromise) {
    initPromise = runInit().catch((err) => { initPromise = null; throw err; });
  }
  await initPromise;
}

// ════════════════════════════════════════════════════════════
// 미들웨어 · 인증
// ════════════════════════════════════════════════════════════
app.use(express.json({ limit: '20kb' }));

// /api 요청 전에 DB 를 준비한다 (헬스체크도 DB 연결을 확인하므로 포함).
app.use('/api', async (req, res, next) => {
  if (!JWT_SECRET) return next(new Error('JWT_SECRET 이 설정되지 않았습니다.'));
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[initDB]', err.message);
    res.status(503).json({ success: false, message: 'DB 연결에 실패했습니다. DATABASE_URL 을 확인해 주세요.' });
  }
});

const ok = (res, data) => res.json({ success: true, data });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const issueToken = (player) => jwt.sign({ sub: player.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
const publicPlayer = (p) => ({ id: p.id, nickname: p.nickname, joinedAt: p.joined_at });

/** null = 토큰 없음, undefined = 만료·위조, 숫자 = 참가자 id */
function readToken(req) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    return jwt.verify(token, JWT_SECRET).sub;
  } catch {
    return undefined;
  }
}

function requireAuth(req, res, next) {
  const id = readToken(req);
  if (id === null) return next(new HttpError(401, '리그에 참가하거나 로그인해 주세요.'));
  if (id === undefined) return next(new HttpError(401, '로그인이 만료되었습니다. 다시 로그인해 주세요.'));
  req.playerId = id;
  next();
}

// 시세 화면처럼 누구나 볼 수 있지만, 로그인했다면 내 정보를 덧붙이는 곳에 쓴다.
// 만료된 토큰은 조용히 무시한다 (보기만 하는 화면이라 막을 이유가 없다).
function optionalAuth(req, res, next) {
  const id = readToken(req);
  req.playerId = typeof id === 'number' ? id : null;
  next();
}

// ════════════════════════════════════════════════════════════
// 평가 (참가자 계좌 · 리그 공통)
// ════════════════════════════════════════════════════════════
/** 보유 행들에 현재가를 붙여 원화 평가액·손익을 계산한다. */
async function valueHoldings(rows) {
  const quotes = await fetchQuotes([...new Set(rows.map((r) => r.symbol))]);
  // 환율을 못 가져와도 현황판 전체가 깨지지 않도록, 달러 종목만 원금으로 평가한다.
  const usd = rows.some((r) => r.currency === 'USD') ? await fxToKrw('USD').catch(() => null) : null;

  const holdings = rows.map((r) => {
    const q = quotes[r.symbol];
    const fx = r.currency === 'USD' ? usd : 1;
    const costKrw = num(r.cost_krw);
    const priced = q && fx;
    const valueKrw = priced ? q.price * r.qty * fx : costKrw;   // 시세가 없으면 원금으로 (stale 표시)
    return {
      playerId: r.player_id,
      symbol: r.symbol,
      name: r.name,
      currency: r.currency,
      qty: r.qty,
      avgPrice: num(r.avg_price),
      price: q ? q.price : null,
      changePct: q ? q.changePct : null,
      costKrw,
      valueKrw,
      pnlKrw: valueKrw - costKrw,
      pnlPct: costKrw ? ((valueKrw - costKrw) / costKrw) * 100 : 0,
      stale: !priced,
    };
  });
  return { holdings, usdKrw: usd };
}

/** 참가자 1명의 계좌 요약. */
function summarize(player, holdings, realizedKrw) {
  const cash = num(player.cash);
  const initial = num(player.initial_cash);
  const stockValue = holdings.reduce((s, h) => s + h.valueKrw, 0);
  const stockCost = holdings.reduce((s, h) => s + h.costKrw, 0);
  const total = cash + stockValue;
  return {
    cash,
    initialCash: initial,
    stockValue,
    stockCost,
    unrealizedKrw: stockValue - stockCost,
    realizedKrw,
    total,
    returnPct: ((total - initial) / initial) * 100,
  };
}

/** 리그 전체 순위를 계산한다. 현황판과 참가자 상세가 같이 쓴다. */
async function buildLeague() {
  const [players, holdRows] = await Promise.all([
    pool.query(`
      SELECT p.id, p.nickname, p.cash, p.initial_cash, p.reset_count, p.joined_at,
             COUNT(t.id)::int AS trade_count,
             COALESCE(SUM(t.realized_krw), 0) AS realized_krw,
             MAX(t.created_at) AS last_trade_at
        FROM stocksim_players p
        LEFT JOIN stocksim_league_trades t ON t.player_id = p.id
       GROUP BY p.id`),
    pool.query('SELECT * FROM stocksim_league_holdings'),
  ]);
  const { holdings, usdKrw } = await valueHoldings(holdRows.rows);

  const byPlayer = new Map();
  for (const h of holdings) {
    if (!byPlayer.has(h.playerId)) byPlayer.set(h.playerId, []);
    byPlayer.get(h.playerId).push(h);
  }

  const standings = players.rows.map((p) => {
    const mine = byPlayer.get(p.id) || [];
    const best = mine.reduce((b, h) => (!b || h.pnlPct > b.pnlPct ? h : b), null);
    return {
      id: p.id,
      nickname: p.nickname,
      joinedAt: p.joined_at,
      resetCount: p.reset_count,
      tradeCount: p.trade_count,
      lastTradeAt: p.last_trade_at,
      ...summarize(p, mine, num(p.realized_krw)),
      holdingCount: mine.length,
      best: best ? { symbol: best.symbol, name: best.name, pnlPct: best.pnlPct } : null,
      holdings: mine,
    };
  });

  // 화면에 보이는 소수 둘째 자리 기준으로 순위를 매긴다. 같으면 공동 순위, 표시 순서는 먼저 참가한 사람.
  // (toFixed 문자열로 비교하면 "-0.00" 과 "0.00" 이 달라 보여서 숫자로 반올림한다)
  const r2 = (v) => Math.round(v * 100);
  standings.sort((a, b) => r2(b.returnPct) - r2(a.returnPct) || new Date(a.joinedAt) - new Date(b.joinedAt));
  standings.forEach((s, i) => {
    const prev = standings[i - 1];
    s.rank = prev && r2(prev.returnPct) === r2(s.returnPct) ? prev.rank : i + 1;
  });
  return { standings, usdKrw };
}

// ════════════════════════════════════════════════════════════
// 참가 · 로그인
// ════════════════════════════════════════════════════════════
function readCredentials(body) {
  const nickname = String(body?.nickname ?? '').trim();
  const password = String(body?.password ?? '');
  return { nickname, password };
}

app.post('/api/auth/join', async (req, res) => {
  const { nickname, password } = readCredentials(req.body);
  if (!NICKNAME_RE.test(nickname)) throw new HttpError(400, '닉네임은 한글·영문·숫자·_ 로 2~12자입니다.');
  if (password.length < PASSWORD_MIN) throw new HttpError(400, `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`);
  if (Buffer.byteLength(password) > PASSWORD_MAX) throw new HttpError(400, '비밀번호가 너무 깁니다.');

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const { rows: [player] } = await pool.query(
      `INSERT INTO stocksim_players (nickname, password_hash, cash, initial_cash)
       VALUES ($1, $2, $3, $3) RETURNING id, nickname, joined_at`,
      [nickname, hash, INITIAL_CASH],
    );
    res.status(201).json({ success: true, data: { token: issueToken(player), player: publicPlayer(player) } });
  } catch (err) {
    // 미리 SELECT 로 확인하면 동시 요청이 둘 다 통과할 수 있어 UNIQUE 위반(23505)으로 판단한다.
    if (err.code === '23505') throw new HttpError(409, '이미 쓰고 있는 닉네임입니다.');
    throw err;
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { nickname, password } = readCredentials(req.body);
  if (!nickname || !password) throw new HttpError(400, '닉네임과 비밀번호를 입력해 주세요.');
  const { rows: [player] } = await pool.query('SELECT * FROM stocksim_players WHERE nickname = $1', [nickname]);
  // 닉네임은 현황판에 공개되므로 존재 여부는 숨길 필요가 없지만, 문구는 하나로 통일한다.
  const valid = player && await bcrypt.compare(password, player.password_hash);
  if (!valid) throw new HttpError(401, '닉네임 또는 비밀번호가 올바르지 않습니다.');
  ok(res, { token: issueToken(player), player: publicPlayer(player) });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const { rows: [player] } = await pool.query('SELECT id, nickname, joined_at FROM stocksim_players WHERE id = $1', [req.playerId]);
  if (!player) throw new HttpError(401, '참가자 정보를 찾을 수 없습니다. 다시 로그인해 주세요.');
  ok(res, publicPlayer(player));
});

// ════════════════════════════════════════════════════════════
// 리그 현황판
// ════════════════════════════════════════════════════════════
app.get('/api/league', async (req, res) => {
  const [{ standings, usdKrw }, recent] = await Promise.all([
    buildLeague(),
    pool.query(`
      SELECT t.id, t.player_id, p.nickname, t.symbol, t.name, t.side, t.qty, t.price, t.currency,
             t.amount_krw, t.realized_krw, t.created_at
        FROM stocksim_league_trades t JOIN stocksim_players p ON p.id = t.player_id
       ORDER BY t.id DESC LIMIT 15`),
  ]);

  // 리그에서 많이 들고 있는 종목: 보유 인원 수 → 평가액 순
  const bySymbol = new Map();
  for (const s of standings) {
    for (const h of s.holdings) {
      const cur = bySymbol.get(h.symbol) || { symbol: h.symbol, name: h.name, holders: 0, valueKrw: 0, changePct: h.changePct };
      cur.holders += 1;
      cur.valueKrw += h.valueKrw;
      bySymbol.set(h.symbol, cur);
    }
  }
  const popularHoldings = [...bySymbol.values()]
    .sort((a, b) => b.holders - a.holders || b.valueKrw - a.valueKrw)
    .slice(0, 8);

  const n = standings.length;
  ok(res, {
    stats: {
      players: n,
      avgReturnPct: n ? standings.reduce((s, x) => s + x.returnPct, 0) / n : 0,
      winners: standings.filter((s) => s.returnPct > 0).length,
      totalTrades: standings.reduce((s, x) => s + x.tradeCount, 0),
    },
    standings: standings.map(({ holdings, ...rest }) => rest),   // 목록에는 보유 상세를 빼서 가볍게
    recentTrades: recent.rows.map((r) => ({
      id: r.id, playerId: r.player_id, nickname: r.nickname, symbol: r.symbol, name: r.name,
      side: r.side, qty: r.qty, price: num(r.price), currency: r.currency,
      amountKrw: num(r.amount_krw), realizedKrw: num(r.realized_krw), createdAt: r.created_at,
    })),
    popularHoldings,
    usdKrw,
    updatedAt: Date.now(),
  });
});

app.get('/api/league/players/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, '올바르지 않은 참가자입니다.');
  const { standings } = await buildLeague();
  const me = standings.find((s) => s.id === id);
  if (!me) throw new HttpError(404, '참가자를 찾을 수 없습니다.');
  const trades = await pool.query(
    `SELECT id, symbol, name, side, qty, price, currency, amount_krw, fee_krw, realized_krw, created_at
       FROM stocksim_league_trades WHERE player_id = $1 ORDER BY id DESC LIMIT 50`, [id],
  );
  me.holdings.sort((a, b) => b.valueKrw - a.valueKrw);
  ok(res, { ...me, totalPlayers: standings.length, trades: trades.rows.map(tradeRow) });
});

// ════════════════════════════════════════════════════════════
// 시세 · 검색
// ════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  ok(res, { db: true, openai: Boolean(OPENAI_API_KEY) });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (!q) return ok(res, []);

  const results = [];
  const seen = new Set();
  const push = (item) => { if (!seen.has(item.symbol)) { seen.add(item.symbol); results.push(item); } };

  // 1) 한글 별칭 (부분 일치)
  const lower = q.toLowerCase();
  for (const [name, symbol] of KR_ALIASES) {
    if (name.toLowerCase().includes(lower)) push({ symbol, name, exchange: symbol.endsWith('.KQ') ? 'KOSDAQ' : symbol.endsWith('.KS') ? 'KOSPI' : 'US' });
  }

  // 2) 6자리 국내 종목코드 → 코스피(.KS) 먼저, 없으면 코스닥(.KQ)
  if (/^\d{6}$/.test(q)) {
    for (const suffix of ['.KS', '.KQ']) {
      try {
        const quote = await fetchQuote(q + suffix);
        push({ symbol: quote.symbol, name: quote.name, exchange: quote.exchange });
        break;
      } catch { /* 다음 시장 시도 */ }
    }
  }

  // 3) Yahoo 검색 (영문·티커). 한글이 섞여 있으면 Yahoo 가 400 을 주므로 건너뛴다.
  if (/^[\x20-\x7E]+$/.test(q)) {
    try {
      const json = await yahooGet(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`);
      for (const it of json.quotes || []) {
        if (!['EQUITY', 'ETF'].includes(it.quoteType) || !SYMBOL_RE.test(it.symbol || '')) continue;
        push({
          symbol: it.symbol,
          name: KR_NAME_BY_SYMBOL[it.symbol] || it.longname || it.shortname || it.symbol,
          exchange: it.exchDisp || it.exchange,
        });
      }
    } catch (err) {
      if (!results.length) throw err;
    }
  }

  ok(res, results.slice(0, 12));
});

app.get('/api/popular', async (req, res) => {
  const quotes = await fetchQuotes(POPULAR);
  ok(res, POPULAR.map((s) => quotes[s]).filter(Boolean));
});

app.get('/api/stocks/:symbol', optionalAuth, async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);
  const range = RANGES[req.query.range] ? req.query.range : '3mo';
  const { quote, points } = await fetchChart(symbol, range);
  const fx = quote.currency === 'USD' ? await fxToKrw('USD') : quote.currency === 'KRW' ? 1 : null;

  let holding = null, watched = false, cash = null;
  if (req.playerId) {
    const [h, w, p] = await Promise.all([
      pool.query('SELECT qty, avg_price, cost_krw FROM stocksim_league_holdings WHERE player_id = $1 AND symbol = $2', [req.playerId, quote.symbol]),
      pool.query('SELECT 1 FROM stocksim_league_watchlist WHERE player_id = $1 AND symbol = $2', [req.playerId, quote.symbol]),
      pool.query('SELECT cash FROM stocksim_players WHERE id = $1', [req.playerId]),
    ]);
    const r = h.rows[0];
    holding = r ? { qty: r.qty, avgPrice: num(r.avg_price), costKrw: num(r.cost_krw) } : null;
    watched = w.rowCount > 0;
    cash = p.rows[0] ? num(p.rows[0].cash) : null;
  }

  ok(res, { quote, points, range, fx, tradable: fx !== null, feeRate: FEE_RATE, holding, watched, cash });
});

// ════════════════════════════════════════════════════════════
// 내 계좌 · 매매
// ════════════════════════════════════════════════════════════
const tradeRow = (r) => ({
  id: r.id, symbol: r.symbol, name: r.name, side: r.side, qty: r.qty,
  price: num(r.price), currency: r.currency, fx: num(r.fx_rate),
  amountKrw: num(r.amount_krw), feeKrw: num(r.fee_krw), realizedKrw: num(r.realized_krw),
  createdAt: r.created_at,
});

app.get('/api/portfolio', requireAuth, async (req, res) => {
  const [acc, hold, realized] = await Promise.all([
    pool.query('SELECT * FROM stocksim_players WHERE id = $1', [req.playerId]),
    pool.query('SELECT * FROM stocksim_league_holdings WHERE player_id = $1 ORDER BY cost_krw DESC', [req.playerId]),
    pool.query('SELECT COALESCE(SUM(realized_krw), 0) AS r FROM stocksim_league_trades WHERE player_id = $1', [req.playerId]),
  ]);
  const player = acc.rows[0];
  if (!player) throw new HttpError(401, '참가자 정보를 찾을 수 없습니다. 다시 로그인해 주세요.');
  const { holdings, usdKrw } = await valueHoldings(hold.rows);
  ok(res, {
    nickname: player.nickname,
    resetAt: player.reset_at,
    resetCount: player.reset_count,
    ...summarize(player, holdings, num(realized.rows[0].r)),
    usdKrw,
    holdings,
  });
});

app.post('/api/trades', requireAuth, async (req, res) => {
  const symbol = normalizeSymbol(req.body?.symbol);
  const side = req.body?.side;
  const qty = Number(req.body?.qty);
  if (!['BUY', 'SELL'].includes(side)) throw new HttpError(400, '매수 또는 매도를 선택해 주세요.');
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, `수량은 1~${MAX_QTY.toLocaleString()}주 사이 정수여야 합니다.`);

  // 가격은 클라이언트 값을 믿지 않고 서버가 직접 조회한다.
  const quote = await fetchQuote(symbol);
  const fx = await fxToKrw(quote.currency);
  const amountKrw = Math.round(quote.price * qty * fx);
  const feeKrw = Math.round(amountKrw * FEE_RATE);
  const pid = req.playerId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 내 계좌 행을 잠가 동시 주문이 같은 현금을 두 번 쓰지 못하게 한다.
    const acc = await client.query('SELECT cash FROM stocksim_players WHERE id = $1 FOR UPDATE', [pid]);
    if (!acc.rows[0]) throw new HttpError(401, '참가자 정보를 찾을 수 없습니다. 다시 로그인해 주세요.');
    const cash = num(acc.rows[0].cash);
    const held = await client.query(
      'SELECT qty, avg_price, cost_krw FROM stocksim_league_holdings WHERE player_id = $1 AND symbol = $2 FOR UPDATE',
      [pid, quote.symbol],
    );
    const h = held.rows[0];
    let realizedKrw = null;

    if (side === 'BUY') {
      const need = amountKrw + feeKrw;
      if (need > cash) throw new HttpError(400, `예수금이 부족합니다. 필요 ${need.toLocaleString()}원 / 보유 ${Math.floor(cash).toLocaleString()}원`);
      await client.query('UPDATE stocksim_players SET cash = cash - $2 WHERE id = $1', [pid, need]);
      if (h) {
        const newQty = h.qty + qty;
        const newAvg = (num(h.avg_price) * h.qty + quote.price * qty) / newQty;
        await client.query(
          `UPDATE stocksim_league_holdings SET qty = $3, avg_price = $4, cost_krw = cost_krw + $5, updated_at = now()
            WHERE player_id = $1 AND symbol = $2`,
          [pid, quote.symbol, newQty, newAvg, need],
        );
      } else {
        await client.query(
          `INSERT INTO stocksim_league_holdings (player_id, symbol, name, currency, qty, avg_price, cost_krw)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [pid, quote.symbol, quote.name, quote.currency, qty, quote.price, need],
        );
      }
    } else {
      if (!h || h.qty < qty) throw new HttpError(400, `보유 수량이 부족합니다 (보유 ${h ? h.qty : 0}주).`);
      // 매입 원금은 수량 비율로 덜어낸다 (평균 단가 방식).
      const costPart = Math.round((num(h.cost_krw) * qty) / h.qty);
      const proceeds = amountKrw - feeKrw;
      realizedKrw = proceeds - costPart;
      await client.query('UPDATE stocksim_players SET cash = cash + $2 WHERE id = $1', [pid, proceeds]);
      if (h.qty === qty) {
        await client.query('DELETE FROM stocksim_league_holdings WHERE player_id = $1 AND symbol = $2', [pid, quote.symbol]);
      } else {
        await client.query(
          `UPDATE stocksim_league_holdings SET qty = qty - $3, cost_krw = cost_krw - $4, updated_at = now()
            WHERE player_id = $1 AND symbol = $2`,
          [pid, quote.symbol, qty, costPart],
        );
      }
    }

    const t = await client.query(
      `INSERT INTO stocksim_league_trades (player_id, symbol, name, side, qty, price, currency, fx_rate, amount_krw, fee_krw, realized_krw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [pid, quote.symbol, quote.name, side, qty, quote.price, quote.currency, fx, amountKrw, feeKrw, realizedKrw],
    );
    await client.query('COMMIT');
    ok(res, {
      id: t.rows[0].id, symbol: quote.symbol, name: quote.name, side, qty,
      price: quote.price, currency: quote.currency, fx, amountKrw, feeKrw, realizedKrw,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

app.get('/api/trades', requireAuth, async (req, res) => {
  const params = [req.playerId];
  let where = 'WHERE player_id = $1';
  if (req.query.symbol) { params.push(normalizeSymbol(req.query.symbol)); where += ' AND symbol = $2'; }
  const { rows } = await pool.query(
    `SELECT * FROM stocksim_league_trades ${where} ORDER BY id DESC LIMIT 200`, params,
  );
  ok(res, rows.map(tradeRow));
});

app.post('/api/account/reset', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM stocksim_players WHERE id = $1 FOR UPDATE', [req.playerId]);
    await client.query('DELETE FROM stocksim_league_holdings WHERE player_id = $1', [req.playerId]);
    await client.query('DELETE FROM stocksim_league_trades WHERE player_id = $1', [req.playerId]);
    // 리셋하면 손실을 지울 수 있으므로, 현황판에 리셋 횟수를 공개한다.
    await client.query(
      'UPDATE stocksim_players SET cash = initial_cash, reset_count = reset_count + 1, reset_at = now() WHERE id = $1',
      [req.playerId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  ok(res, { cash: INITIAL_CASH });
});

// ════════════════════════════════════════════════════════════
// 관심 종목 (참가자별)
// ════════════════════════════════════════════════════════════
app.get('/api/watchlist', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT symbol, name FROM stocksim_league_watchlist WHERE player_id = $1 ORDER BY added_at', [req.playerId],
  );
  const quotes = await fetchQuotes(rows.map((r) => r.symbol));
  ok(res, rows.map((r) => quotes[r.symbol] || { symbol: r.symbol, name: r.name, price: null }));
});

app.post('/api/watchlist', requireAuth, async (req, res) => {
  const quote = await fetchQuote(normalizeSymbol(req.body?.symbol));   // 존재하는 종목인지 확인
  await pool.query(
    `INSERT INTO stocksim_league_watchlist (player_id, symbol, name) VALUES ($1, $2, $3)
     ON CONFLICT (player_id, symbol) DO NOTHING`,
    [req.playerId, quote.symbol, quote.name],
  );
  ok(res, quote);
});

app.delete('/api/watchlist/:symbol', requireAuth, async (req, res) => {
  await pool.query(
    'DELETE FROM stocksim_league_watchlist WHERE player_id = $1 AND symbol = $2',
    [req.playerId, normalizeSymbol(req.params.symbol)],
  );
  ok(res, null);
});

// ════════════════════════════════════════════════════════════
// AI 리서치 (OpenAI) — 기록은 리그 전체가 공유
// ════════════════════════════════════════════════════════════
const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'outlook', 'confidence', 'business', 'strengths', 'risks', 'technical', 'newsTakeaways', 'checkpoints'],
  properties: {
    summary: { type: 'string', description: '한두 문장 핵심 요약' },
    outlook: { type: 'string', enum: ['bullish', 'neutral', 'bearish'] },
    confidence: { type: 'integer', description: '판단 확신도 1~5' },
    business: { type: 'string', description: '무엇으로 돈을 버는 회사인지 2~3문장' },
    strengths: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    technical: { type: 'string', description: '제공된 가격 데이터로 본 추세 해석' },
    newsTakeaways: { type: 'array', items: { type: 'string' } },
    checkpoints: { type: 'array', items: { type: 'string' }, description: '앞으로 확인할 지표·이벤트' },
  },
};

const pct = (a, b) => (a && b ? (((a - b) / b) * 100).toFixed(1) + '%' : '데이터 없음');

/** 분석 근거로 쓸 숫자를 서버가 직접 계산해 프롬프트에 넣는다. */
async function buildResearchContext(symbol) {
  const [{ quote, points: yearly }, { points: monthly }, news] = await Promise.all([
    fetchChart(symbol, '1y'), fetchChart(symbol, '1mo'), searchNews(symbol),
  ]);
  const p = quote.price;
  const back = (arr, n) => (arr.length > n ? arr[arr.length - 1 - n].c : arr[0]?.c);
  const metrics = {
    현재가: `${p} ${quote.currency}`,
    전일대비: `${quote.changePct.toFixed(2)}%`,
    '1개월 수익률': pct(p, monthly[0]?.c),
    '3개월 수익률': pct(p, back(yearly, 13)),
    '1년 수익률': pct(p, yearly[0]?.c),
    '52주 최고': quote.high52, '52주 최저': quote.low52,
    '52주 최고 대비': pct(p, quote.high52),
    거래소: quote.exchange,
  };
  return { quote, metrics, news: news.slice(0, 8) };
}

async function callOpenAI(ctx) {
  const newsText = ctx.news.length
    ? ctx.news.map((n) => `- ${n.title} (${n.publisher}, ${n.time ? new Date(n.time).toISOString().slice(0, 10) : '날짜 미상'})`).join('\n')
    : '- (가져온 뉴스 없음)';

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: '당신은 개인 투자자의 모의투자 공부를 돕는 주식 리서치 애널리스트입니다. '
            + '한국어로, 제공된 숫자와 뉴스 헤드라인을 근거로 균형 있게 분석합니다. '
            + '제공되지 않은 실적 수치나 목표주가를 지어내지 말고, 모르는 것은 "확인 필요"라고 씁니다. '
            + 'strengths·risks 는 각 3개, newsTakeaways 는 0~3개, checkpoints 는 2~4개로 씁니다.',
        },
        {
          role: 'user',
          content: `종목: ${ctx.quote.name} (${ctx.quote.symbol}, ${ctx.quote.englishName})\n\n`
            + `[가격 지표]\n${Object.entries(ctx.metrics).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\n`
            + `[최근 뉴스 헤드라인]\n${newsText}`,
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'stock_report', strict: true, schema: REPORT_SCHEMA } },
    }),
  });
  if (!res.ok) {
    console.error('[openai]', res.status, (await res.text()).slice(0, 500));
    if (res.status === 401) throw new HttpError(502, 'OpenAI 인증에 실패했습니다. API 키를 확인해 주세요.');
    if (res.status === 429) throw new HttpError(429, 'OpenAI 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.');
    throw new HttpError(502, 'AI 분석 요청에 실패했습니다.');
  }
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content);
}

/** Structured Outputs 라도 길이·범위가 이상할 수 있으므로 저장 전에 보정한다. */
function sanitizeReport(r) {
  const str = (v, max) => String(v || '').trim().slice(0, max);
  const list = (v, n) => (Array.isArray(v) ? v : []).map((x) => str(x, 300)).filter(Boolean).slice(0, n);
  return {
    summary: str(r.summary, 400) || '요약을 생성하지 못했습니다.',
    outlook: ['bullish', 'neutral', 'bearish'].includes(r.outlook) ? r.outlook : 'neutral',
    confidence: Math.min(5, Math.max(1, Math.round(Number(r.confidence) || 3))),
    business: str(r.business, 600),
    strengths: list(r.strengths, 5),
    risks: list(r.risks, 5),
    technical: str(r.technical, 600),
    newsTakeaways: list(r.newsTakeaways, 4),
    checkpoints: list(r.checkpoints, 5),
  };
}

const researchRow = (r) => ({
  id: r.id, symbol: r.symbol, name: r.name, currency: r.currency, price: num(r.price),
  outlook: r.outlook, summary: r.summary, report: r.report, model: r.model, createdAt: r.created_at,
  author: r.nickname || null,
});

app.get('/api/research', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.symbol) { params.push(normalizeSymbol(req.query.symbol)); where = 'WHERE r.symbol = $1'; }
  const { rows } = await pool.query(
    `SELECT r.*, p.nickname FROM stocksim_research r LEFT JOIN stocksim_players p ON p.id = r.player_id
     ${where} ORDER BY r.id DESC LIMIT 100`, params,
  );
  // 분석 이후 가격이 얼마나 움직였는지 비교하려고 현재가를 붙인다.
  const quotes = await fetchQuotes([...new Set(rows.map((r) => r.symbol))]);
  ok(res, rows.map((r) => ({ ...researchRow(r), currentPrice: quotes[r.symbol]?.price ?? null })));
});

// AI 호출에는 비용이 들기 때문에 참가자만 생성할 수 있다.
app.post('/api/research', requireAuth, async (req, res) => {
  if (!OPENAI_API_KEY) throw new HttpError(503, 'OPENAI_API_KEY 가 설정되지 않았습니다.');
  const symbol = normalizeSymbol(req.body?.symbol);
  const ctx = await buildResearchContext(symbol);
  const report = sanitizeReport(await callOpenAI(ctx));
  report.metrics = ctx.metrics;
  report.news = ctx.news.slice(0, 5);

  const { rows } = await pool.query(
    `INSERT INTO stocksim_research (symbol, name, currency, price, outlook, summary, report, model, player_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *, (SELECT nickname FROM stocksim_players WHERE id = $9) AS nickname`,
    [ctx.quote.symbol, ctx.quote.name, ctx.quote.currency, ctx.quote.price, report.outlook, report.summary, report, OPENAI_MODEL, req.playerId],
  );
  ok(res, { ...researchRow(rows[0]), currentPrice: ctx.quote.price });
});

// ════════════════════════════════════════════════════════════
// 정적 파일 · 에러 처리
// ════════════════════════════════════════════════════════════
app.use('/api', (req, res) => res.status(404).json({ success: false, message: '없는 API 입니다.' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Express 5 는 async 핸들러의 예외를 여기로 넘겨준다.
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: '요청 형식이 올바르지 않습니다.' });
  console.error('[error]', err);
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`📈 모의투자 리서치 → http://localhost:${PORT}`));
}

module.exports = app;
