const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── In-memory store ──────────────────────────
// 서버 재시작 시 초기화되어도 되는 읽기 전용 도감 데이터.
// height 는 dm, weight 는 hg 단위 (클라이언트가 m / kg 로 변환한다).

const TYPE_NAMES = {
  normal: '노말', fighting: '격투', flying: '비행', poison: '독', ground: '땅', rock: '바위',
  bug: '벌레', ghost: '고스트', steel: '강철', fire: '불꽃', water: '물', grass: '풀',
  electric: '전기', psychic: '에스퍼', ice: '얼음', dragon: '드래곤', dark: '악', fairy: '페어리',
};

const GENERATION_NAMES = { 1: '1세대', 2: '2세대', 3: '3세대', 4: '4세대', 5: '5세대', 6: '6세대', 7: '7세대', 8: '8세대', 9: '9세대' };

const STAT_LABELS = [
  ['hp', 'HP'],
  ['attack', '공격'],
  ['defense', '방어'],
  ['specialAttack', '특수공격'],
  ['specialDefense', '특수방어'],
  ['speed', '스피드'],
];

const pokemons = [
  {
    id: 1, enName: 'bulbasaur', koName: '덩굴싹', genus: '씨앗포켓몬', generationId: 1,
    types: ['grass', 'poison'], height: 7, weight: 69,
    description: '태어났을 때부터 등에 이상한 씨앗이 심어져 있다. 몸과 함께 씨앗도 조금씩 자라난다.',
    abilities: [{ name: '심록', hidden: false }, { name: '엽록소', hidden: true }],
    stats: { hp: 45, attack: 49, defense: 49, specialAttack: 65, specialDefense: 65, speed: 45 },
  },
  {
    id: 4, enName: 'charmander', koName: '불꼬리', genus: '도롱뇽포켓몬', generationId: 1,
    types: ['fire'], height: 6, weight: 85,
    description: '꼬리 끝에서 타오르는 불꽃은 생명력의 상징이다. 기운이 넘칠 때는 불꽃이 더 크게 타오른다.',
    abilities: [{ name: '맹화', hidden: false }, { name: '선파워', hidden: true }],
    stats: { hp: 39, attack: 52, defense: 43, specialAttack: 60, specialDefense: 50, speed: 65 },
  },
  {
    id: 7, enName: 'squirtle', koName: '거품등', genus: '꼬마거북포켓몬', generationId: 1,
    types: ['water'], height: 5, weight: 90,
    description: '위험을 느끼면 등껍질 속에 몸을 숨긴다. 틈을 보아 입에서 힘찬 물줄기를 발사한다.',
    abilities: [{ name: '급류', hidden: false }, { name: '젖은접시', hidden: true }],
    stats: { hp: 44, attack: 48, defense: 65, specialAttack: 50, specialDefense: 64, speed: 43 },
  },
  {
    id: 25, enName: 'pikachu', koName: '번개볼', genus: '쥐포켓몬', generationId: 1,
    types: ['electric'], height: 4, weight: 60,
    description: '볼의 전기 주머니에 전기를 모아 둔다. 화가 나면 모아 둔 전기를 한꺼번에 방출한다.',
    abilities: [{ name: '정전기', hidden: false }, { name: '피뢰침', hidden: true }],
    stats: { hp: 35, attack: 55, defense: 40, specialAttack: 50, specialDefense: 50, speed: 90 },
  },
  {
    id: 150, enName: 'mewtwo', koName: '초능뮤', genus: '유전포켓몬', generationId: 1,
    types: ['psychic'], height: 20, weight: 1220,
    description: '유전자 조작으로 만들어진 포켓몬. 인간의 과학력으로 몸은 만들었지만 상냥한 마음은 만들지 못했다.',
    abilities: [{ name: '프레셔', hidden: false }, { name: '긴장감', hidden: true }],
    stats: { hp: 106, attack: 110, defense: 90, specialAttack: 154, specialDefense: 90, speed: 130 },
  },
];

// 목록 카드용 요약
const toIndexEntry = (p) => ({
  id: p.id,
  enName: p.enName,
  koName: p.koName,
  genus: p.genus,
  generationId: p.generationId,
  types: p.types.map((en) => ({ en, ko: TYPE_NAMES[en] || en })),
  sprite: `/sprites/${p.id}.png`,
  artwork: `/sprites/artwork/${p.id}.png`,
});

// 상세 모달용
const toDetail = (p) => ({
  ...toIndexEntry(p),
  height: p.height,
  weight: p.weight,
  description: p.description,
  abilities: p.abilities,
  stats: STAT_LABELS.map(([key, label]) => ({ key, label, value: p.stats[key] })),
});

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use('/sprites', express.static(path.join(__dirname, 'sprites')));

// ── API routes ───────────────────────────────
// 필터 드롭다운에는 실제로 등록된 타입/세대만 보여준다.
app.get('/api/pokemon', (_req, res, next) => {
  try {
    const sorted = [...pokemons].sort((a, b) => a.id - b.id);
    const usedTypes = new Set(sorted.flatMap((p) => p.types));
    const usedGens = [...new Set(sorted.map((p) => p.generationId))].sort((a, b) => a - b);

    res.json({
      success: true,
      data: {
        pokemons: sorted.map(toIndexEntry),
        types: Object.keys(TYPE_NAMES).filter((en) => usedTypes.has(en)).map((en) => ({ en, ko: TYPE_NAMES[en] })),
        generations: usedGens.map((id) => ({ id, ko: GENERATION_NAMES[id] || `${id}세대` })),
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/pokemon/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '도감번호는 양의 정수여야 합니다' });
    }
    const pokemon = pokemons.find((p) => p.id === id);
    if (!pokemon) {
      return res.status(404).json({ success: false, message: `No.${id} 포켓몬은 도감에 없습니다` });
    }
    res.json({ success: true, data: toDetail(pokemon) });
  } catch (err) {
    next(err);
  }
});

// 등록되지 않은 API 경로는 index.html 대신 JSON 404
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Pokedex server running on http://localhost:${PORT}`));
}
module.exports = app;
