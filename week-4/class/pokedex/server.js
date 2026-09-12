// ============================================================
// 포켓몬 도감 API 서버
// ------------------------------------------------------------
// PokeAPI 를 대체하는 자체 REST API. 외부 의존성 없이 Node 내장
// 모듈만 사용하므로 `node server.js` 만으로 바로 뜬다.
//
//   GET /api/pokemon        → 도감 색인 (목록 + 타입/세대 필터 옵션)
//   GET /api/pokemon/:id    → 상세 정보 (종족값/특성/설명)
//   GET /api/health         → 헬스체크
//   그 외                    → public/ 정적 파일 (index.html, 스프라이트)
// ============================================================

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'pokemon.json');

// ------------------------------------------------------------
// 데이터 로드 — 기동 시 한 번만 읽어 메모리에 올린다.
// ------------------------------------------------------------

const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

const STAT_ORDER = ['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'];

// 목록 카드에 필요한 최소한의 필드만 추린다.
const indexEntry = (p) => ({
  id: p.id,
  enName: p.enName,
  koName: p.koName,
  genus: p.genus,
  generationId: p.generationId,
  types: p.types.map((en) => ({ en, ko: db.types[en] || en })),
  sprite: `/sprites/${p.id}.png`,
  artwork: `/sprites/artwork/${p.id}.png`,
});

// 상세 화면에서 쓰는 형태로 펼친다.
const detailEntry = (p) => ({
  id: p.id,
  height: p.height,   // dm
  weight: p.weight,   // hg
  description: p.description,
  abilities: p.abilities.map((a) => ({ name: a.name, hidden: Boolean(a.hidden) })),
  stats: STAT_ORDER
    .filter((key) => p.stats[key] != null)
    .map((key) => ({ key, label: db.statLabels[key] || key, value: p.stats[key] })),
});

// 필터 옵션은 실제로 등록된 포켓몬에서 역산한다.
// (도감에 없는 타입/세대가 드롭다운에 뜨면 빈 결과만 나오기 때문)
function buildFilters(list) {
  const usedTypes = new Set();
  const usedGens = new Set();
  for (const p of list) {
    p.types.forEach((t) => usedTypes.add(t));
    usedGens.add(p.generationId);
  }

  const types = Object.keys(db.types)
    .filter((en) => usedTypes.has(en))
    .map((en) => ({ en, ko: db.types[en] }));

  const generations = [...usedGens]
    .sort((a, b) => a - b)
    .map((id) => ({ id, ko: db.generations[String(id)] || `${id}세대` }));

  return { types, generations };
}

const pokemonById = new Map(db.pokemon.map((p) => [p.id, p]));
const sortedPokemon = [...db.pokemon].sort((a, b) => a.id - b.id);

const INDEX_PAYLOAD = {
  pokemons: sortedPokemon.map(indexEntry),
  ...buildFilters(sortedPokemon),
  total: sortedPokemon.length,
};

// ------------------------------------------------------------
// 응답 헬퍼
// ------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // index.html 을 file:// 로 직접 열어도 붙을 수 있게 열어 둔다 (학습용 로컬 서버)
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // 경로 이탈(../) 차단
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: '허용되지 않은 경로입니다' });
  }

  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: '페이지를 찾을 수 없습니다' });
  }
}

// ------------------------------------------------------------
// 라우팅
// ------------------------------------------------------------

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    return res.end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'GET 요청만 지원합니다' });
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok', count: sortedPokemon.length });
  }

  if (pathname === '/api/pokemon') {
    return sendJson(res, 200, INDEX_PAYLOAD);
  }

  const detailMatch = pathname.match(/^\/api\/pokemon\/(\d+)$/);
  if (detailMatch) {
    const pokemon = pokemonById.get(Number(detailMatch[1]));
    if (!pokemon) return sendJson(res, 404, { error: '해당 번호의 포켓몬이 도감에 없습니다' });
    return sendJson(res, 200, detailEntry(pokemon));
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: '존재하지 않는 API 입니다' });
  }

  return serveStatic(res, pathname);
}

// 로컬에서 `node server.js` 로 직접 실행할 때만 포트를 연다.
// Vercel 에서는 api/[...path].js 가 이 핸들러만 가져다 쓴다(서버리스라 listen 불필요).
if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`포켓몬 도감 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`등록된 포켓몬 ${sortedPokemon.length}마리 · API: /api/pokemon`);
  });
}

module.exports = handleRequest;
