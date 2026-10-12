// ════════════════════════════════════════════════════════════
// 모의투자 리서치 — API 서버
// Express 5 + Supabase Postgres + Yahoo Finance(시세) + OpenAI(종목 분석)
// 로컬: node server.js  /  Vercel: module.exports = app
//
//   GET    /api/search?q=            → 종목 검색 (한글 별칭 + Yahoo 검색)
//   GET    /api/popular              → 인기 종목 시세
//   GET    /api/stocks/:symbol       → 시세 + 차트 (?range=1mo|3mo|6mo|1y|5y)
//   GET    /api/portfolio            → 계좌 요약 + 보유 종목 (현재가 반영)
//   POST   /api/trades               → 매수/매도 { symbol, side: 'BUY'|'SELL', qty }
//   GET    /api/trades               → 거래 내역 (?symbol=)
//   POST   /api/account/reset        → 계좌 초기화
//   GET    /api/watchlist            → 관심 종목 (시세 포함)
//   POST   /api/watchlist            → 관심 종목 추가 { symbol }
//   DELETE /api/watchlist/:symbol    → 관심 종목 삭제
//   GET    /api/research             → AI 리서치 기록 (?symbol=)
//   POST   /api/research             → AI 리서치 생성 { symbol }
//   GET    /api/health               → 헬스체크
//
// 계좌는 원화(KRW) 하나. 미국 주식은 체결 시점의 USD/KRW 환율로 환산한다.
// 로그인 없이 계좌 1개만 쓰는 학습용 앱이다.
// ════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

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

// ════════════════════════════════════════════════════════════
// Yahoo Finance
// ════════════════════════════════════════════════════════════
// 공식 API가 아니다. v7 quote 는 crumb 이 필요해 401 이 나므로,
// 키 없이 되는 v8 chart 응답의 meta 를 시세로 쓴다.

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
let initPromise = null;

async function runInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stocksim_account (
      id           INT PRIMARY KEY CHECK (id = 1),
      cash         NUMERIC(16,2) NOT NULL CHECK (cash >= 0),
      initial_cash NUMERIC(16,2) NOT NULL,
      reset_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS stocksim_holdings (
      symbol       TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      currency     TEXT NOT NULL,
      qty          INT NOT NULL CHECK (qty > 0),
      avg_price    NUMERIC(18,4) NOT NULL,      -- 현지 통화 평균 단가
      cost_krw     NUMERIC(16,2) NOT NULL,      -- 원화 매입 원금 (수수료 포함)
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS stocksim_trades (
      id           SERIAL PRIMARY KEY,
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
    CREATE INDEX IF NOT EXISTS stocksim_trades_symbol_idx ON stocksim_trades(symbol);
    CREATE TABLE IF NOT EXISTS stocksim_watchlist (
      symbol       TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT now()
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
  `);
  await pool.query(
    `INSERT INTO stocksim_account (id, cash, initial_cash) VALUES (1, $1, $1) ON CONFLICT (id) DO NOTHING`,
    [INITIAL_CASH],
  );
}

async function initDB() {
  if (!initPromise) {
    initPromise = runInit().catch((err) => { initPromise = null; throw err; });
  }
  await initPromise;
}

// ════════════════════════════════════════════════════════════
// 미들웨어
// ════════════════════════════════════════════════════════════
app.use(express.json({ limit: '20kb' }));

// /api 요청 전에 DB 를 준비한다 (헬스체크도 DB 연결을 확인하므로 포함).
app.use('/api', async (req, res, next) => {
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

app.get('/api/stocks/:symbol', async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);
  const range = RANGES[req.query.range] ? req.query.range : '3mo';
  const { quote, points } = await fetchChart(symbol, range);
  const fx = quote.currency === 'USD' ? await fxToKrw('USD') : quote.currency === 'KRW' ? 1 : null;

  const [holding, watch] = await Promise.all([
    pool.query('SELECT qty, avg_price, cost_krw FROM stocksim_holdings WHERE symbol = $1', [quote.symbol]),
    pool.query('SELECT 1 FROM stocksim_watchlist WHERE symbol = $1', [quote.symbol]),
  ]);
  const h = holding.rows[0];
  ok(res, {
    quote,
    points,
    range,
    fx,
    tradable: fx !== null,
    feeRate: FEE_RATE,
    holding: h ? { qty: h.qty, avgPrice: num(h.avg_price), costKrw: num(h.cost_krw) } : null,
    watched: watch.rowCount > 0,
  });
});

// ════════════════════════════════════════════════════════════
// 계좌 · 매매
// ════════════════════════════════════════════════════════════
app.get('/api/portfolio', async (req, res) => {
  const [acc, hold] = await Promise.all([
    pool.query('SELECT cash, initial_cash, reset_at FROM stocksim_account WHERE id = 1'),
    pool.query('SELECT symbol, name, currency, qty, avg_price, cost_krw FROM stocksim_holdings ORDER BY cost_krw DESC'),
  ]);
  const quotes = await fetchQuotes(hold.rows.map((r) => r.symbol));
  const usd = hold.rows.some((r) => r.currency === 'USD') ? await fxToKrw('USD') : null;

  const holdings = hold.rows.map((r) => {
    const q = quotes[r.symbol];
    const fx = r.currency === 'USD' ? usd : 1;
    const costKrw = num(r.cost_krw);
    // 시세를 못 가져오면 평가액을 원금으로 둔다 (stale 표시).
    const valueKrw = q ? q.price * r.qty * fx : costKrw;
    return {
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
      stale: !q,
    };
  });

  const cash = num(acc.rows[0].cash);
  const initial = num(acc.rows[0].initial_cash);
  const stockValue = holdings.reduce((s, h) => s + h.valueKrw, 0);
  const stockCost = holdings.reduce((s, h) => s + h.costKrw, 0);
  const total = cash + stockValue;

  const realized = await pool.query('SELECT COALESCE(SUM(realized_krw), 0) AS r FROM stocksim_trades');
  ok(res, {
    cash,
    initialCash: initial,
    resetAt: acc.rows[0].reset_at,
    stockValue,
    stockCost,
    unrealizedKrw: stockValue - stockCost,
    realizedKrw: num(realized.rows[0].r),
    total,
    returnPct: ((total - initial) / initial) * 100,
    usdKrw: usd,
    holdings,
  });
});

app.post('/api/trades', async (req, res) => {
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 계좌 행을 잠가 동시 주문이 같은 현금을 두 번 쓰지 못하게 한다.
    const acc = await client.query('SELECT cash FROM stocksim_account WHERE id = 1 FOR UPDATE');
    const cash = num(acc.rows[0].cash);
    const held = await client.query('SELECT qty, avg_price, cost_krw FROM stocksim_holdings WHERE symbol = $1 FOR UPDATE', [quote.symbol]);
    const h = held.rows[0];
    let realizedKrw = null;

    if (side === 'BUY') {
      const need = amountKrw + feeKrw;
      if (need > cash) throw new HttpError(400, `예수금이 부족합니다. 필요 ${need.toLocaleString()}원 / 보유 ${Math.floor(cash).toLocaleString()}원`);
      await client.query('UPDATE stocksim_account SET cash = cash - $1 WHERE id = 1', [need]);
      if (h) {
        const newQty = h.qty + qty;
        const newAvg = (num(h.avg_price) * h.qty + quote.price * qty) / newQty;
        await client.query(
          'UPDATE stocksim_holdings SET qty = $2, avg_price = $3, cost_krw = cost_krw + $4, updated_at = now() WHERE symbol = $1',
          [quote.symbol, newQty, newAvg, need],
        );
      } else {
        await client.query(
          'INSERT INTO stocksim_holdings (symbol, name, currency, qty, avg_price, cost_krw) VALUES ($1,$2,$3,$4,$5,$6)',
          [quote.symbol, quote.name, quote.currency, qty, quote.price, need],
        );
      }
    } else {
      if (!h || h.qty < qty) throw new HttpError(400, `보유 수량이 부족합니다 (보유 ${h ? h.qty : 0}주).`);
      // 매입 원금은 수량 비율로 덜어낸다 (평균 단가 방식).
      const costPart = Math.round((num(h.cost_krw) * qty) / h.qty);
      const proceeds = amountKrw - feeKrw;
      realizedKrw = proceeds - costPart;
      await client.query('UPDATE stocksim_account SET cash = cash + $1 WHERE id = 1', [proceeds]);
      if (h.qty === qty) {
        await client.query('DELETE FROM stocksim_holdings WHERE symbol = $1', [quote.symbol]);
      } else {
        await client.query(
          'UPDATE stocksim_holdings SET qty = qty - $2, cost_krw = cost_krw - $3, updated_at = now() WHERE symbol = $1',
          [quote.symbol, qty, costPart],
        );
      }
    }

    const t = await client.query(
      `INSERT INTO stocksim_trades (symbol, name, side, qty, price, currency, fx_rate, amount_krw, fee_krw, realized_krw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
      [quote.symbol, quote.name, side, qty, quote.price, quote.currency, fx, amountKrw, feeKrw, realizedKrw],
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

app.get('/api/trades', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.symbol) { params.push(normalizeSymbol(req.query.symbol)); where = 'WHERE symbol = $1'; }
  const { rows } = await pool.query(
    `SELECT id, symbol, name, side, qty, price, currency, fx_rate, amount_krw, fee_krw, realized_krw, created_at
       FROM stocksim_trades ${where} ORDER BY id DESC LIMIT 200`, params,
  );
  ok(res, rows.map((r) => ({
    id: r.id, symbol: r.symbol, name: r.name, side: r.side, qty: r.qty,
    price: num(r.price), currency: r.currency, fx: num(r.fx_rate),
    amountKrw: num(r.amount_krw), feeKrw: num(r.fee_krw), realizedKrw: num(r.realized_krw),
    createdAt: r.created_at,
  })));
});

app.post('/api/account/reset', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM stocksim_holdings');
    await client.query('DELETE FROM stocksim_trades');
    await client.query('UPDATE stocksim_account SET cash = initial_cash, reset_at = now() WHERE id = 1');
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
// 관심 종목
// ════════════════════════════════════════════════════════════
app.get('/api/watchlist', async (req, res) => {
  const { rows } = await pool.query('SELECT symbol, name FROM stocksim_watchlist ORDER BY added_at');
  const quotes = await fetchQuotes(rows.map((r) => r.symbol));
  ok(res, rows.map((r) => quotes[r.symbol] || { symbol: r.symbol, name: r.name, price: null }));
});

app.post('/api/watchlist', async (req, res) => {
  const quote = await fetchQuote(normalizeSymbol(req.body?.symbol));   // 존재하는 종목인지 확인
  await pool.query(
    'INSERT INTO stocksim_watchlist (symbol, name) VALUES ($1, $2) ON CONFLICT (symbol) DO NOTHING',
    [quote.symbol, quote.name],
  );
  ok(res, quote);
});

app.delete('/api/watchlist/:symbol', async (req, res) => {
  await pool.query('DELETE FROM stocksim_watchlist WHERE symbol = $1', [normalizeSymbol(req.params.symbol)]);
  ok(res, null);
});

// ════════════════════════════════════════════════════════════
// AI 리서치 (OpenAI)
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
});

app.get('/api/research', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.symbol) { params.push(normalizeSymbol(req.query.symbol)); where = 'WHERE symbol = $1'; }
  const { rows } = await pool.query(`SELECT * FROM stocksim_research ${where} ORDER BY id DESC LIMIT 100`, params);
  // 분석 이후 가격이 얼마나 움직였는지 비교하려고 현재가를 붙인다.
  const quotes = await fetchQuotes([...new Set(rows.map((r) => r.symbol))]);
  ok(res, rows.map((r) => ({ ...researchRow(r), currentPrice: quotes[r.symbol]?.price ?? null })));
});

app.post('/api/research', async (req, res) => {
  if (!OPENAI_API_KEY) throw new HttpError(503, 'OPENAI_API_KEY 가 설정되지 않았습니다.');
  const symbol = normalizeSymbol(req.body?.symbol);
  const ctx = await buildResearchContext(symbol);
  const report = sanitizeReport(await callOpenAI(ctx));
  report.metrics = ctx.metrics;
  report.news = ctx.news.slice(0, 5);

  const { rows } = await pool.query(
    `INSERT INTO stocksim_research (symbol, name, currency, price, outlook, summary, report, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [ctx.quote.symbol, ctx.quote.name, ctx.quote.currency, ctx.quote.price, report.outlook, report.summary, report, OPENAI_MODEL],
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
