// 업비트 공개 시세 프록시
//
// 업비트는 `*.vercel.app` 출처의 브라우저 요청에 CORS 헤더를 주지 않는다.
// (localhost 와 example.com 에서는 같은 요청이 200 으로 돌아오는 걸 확인했다.)
// 그래서 서버가 대신 받아 같은 오리진으로 돌려준다.
//
// 공개 API 라 키가 필요 없다. 다만 아무 경로나 중계하면 열린 프록시가 되므로
// 쓰는 두 경로만 허용하고 파라미터도 직접 다시 만든다.

const UPBIT = 'https://api.upbit.com/v1';
const MARKET_RE = /^[A-Z0-9]{1,10}-[A-Z0-9]{1,10}$/;

module.exports = async (req, res) => {
  const path = String((req.query && req.query.path) || '');

  let url;
  if (path === 'market/all') {
    url = `${UPBIT}/market/all?isDetails=false`;
  } else if (path === 'ticker') {
    const markets = String((req.query && req.query.markets) || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => MARKET_RE.test(s))
      .slice(0, 40);

    if (markets.length === 0) {
      res.status(400).json({ error: 'markets 파라미터가 필요합니다.' });
      return;
    }
    url = `${UPBIT}/ticker?markets=${markets.join(',')}`;
  } else {
    res.status(400).json({ error: '허용되지 않은 경로입니다.' });
    return;
  }

  try {
    const upstream = await fetch(url, { headers: { accept: 'application/json' } });

    if (!upstream.ok) {
      // 업비트 응답 원문은 싣지 않는다 (불필요한 정보 노출 방지)
      res.status(upstream.status === 429 ? 429 : 502).json({
        error: `업비트 응답 ${upstream.status}`,
      });
      return;
    }

    const body = await upstream.text();

    // CDN 에서 재사용해 업비트 호출 자체를 줄인다.
    // 시세 10초 / 마켓 목록 1시간 — 방문자가 늘어도 업비트에 가는 요청은 그대로다.
    const maxAge = path === 'ticker' ? 10 : 3600;
    res.setHeader('cache-control', `public, s-maxage=${maxAge}, stale-while-revalidate=60`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.status(200).send(body);
  } catch (e) {
    console.error('[업비트 프록시 실패]', e && e.message);
    res.status(502).json({ error: '업비트에 연결하지 못했습니다.' });
  }
};
