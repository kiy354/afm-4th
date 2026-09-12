# 포켓몬 도감 (자체 API 서버 버전)

기존에 PokeAPI(GraphQL)를 직접 호출하던 단일 파일 React 도감을,
**직접 만든 Node.js API 서버**에서 데이터를 받아 오도록 바꾼 버전이다.
현재 서버에는 포켓몬 **10마리**가 등록돼 있다.

## 실행

```bash
cd week-4/class/pokedex
node server.js          # 또는 npm start
```

→ http://localhost:3000 접속. 외부 패키지 설치가 필요 없다(Node 내장 모듈만 사용).

포트를 바꾸려면 `PORT=4000 node server.js`.

## 구조

```
pokedex/
├── server.js              # API + 정적 파일 서버 (의존성 0)
├── package.json
├── data/pokemon.json      # 도감 데이터 (여기만 고치면 도감이 바뀐다)
└── public/
    ├── index.html         # React 단일 파일 앱 (CDN React + Tailwind)
    └── sprites/           # 도트 스프라이트 + 고해상도 일러스트 (로컬 보관)
```

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/pokemon` | 도감 색인. 목록 + 타입/세대 필터 옵션 + 총 마릿수 |
| GET | `/api/pokemon/:id` | 상세 정보. 키·몸무게·설명·특성·종족값 |
| GET | `/api/health` | 헬스체크 |

필터 옵션(타입·세대)은 고정 목록이 아니라 **등록된 포켓몬에서 역산**한다.
도감에 없는 타입이 드롭다운에 떠서 빈 결과만 보이는 일을 막기 위해서다.

응답 예시:

```jsonc
// GET /api/pokemon
{
  "pokemons": [
    {
      "id": 1, "enName": "bulbasaur", "koName": "덩굴씨",
      "genus": "씨앗포켓몬", "generationId": 1,
      "types": [{ "en": "grass", "ko": "풀" }, { "en": "poison", "ko": "독" }],
      "sprite": "/sprites/1.png", "artwork": "/sprites/artwork/1.png"
    }
  ],
  "types": [{ "en": "grass", "ko": "풀" }],
  "generations": [{ "id": 1, "ko": "1세대 · 관동" }],
  "total": 10
}
```

키는 dm, 몸무게는 hg 단위로 내려주고 화면에서 m·kg 으로 환산한다.

## 등록된 포켓몬 10마리

이름은 이 도감만의 고유 이름으로, **모두 3글자로 통일**했다.

| No. | 이름 | 원본 | 타입 | 세대 |
| --- | --- | --- | --- | --- |
| 0001 | 덩굴씨 | Bulbasaur | 풀 / 독 | 1 |
| 0004 | 불꼬리 | Charmander | 불꽃 | 1 |
| 0007 | 거품북 | Squirtle | 물 | 1 |
| 0025 | 번개볼 | Pikachu | 전기 | 1 |
| 0094 | 어둑령 | Gengar | 고스트 / 독 | 1 |
| 0143 | 먹잠보 | Snorlax | 노말 | 1 |
| 0150 | 초능뮤 | Mewtwo | 에스퍼 | 1 |
| 0248 | 암흑왕 | Tyranitar | 바위 / 악 | 2 |
| 0445 | 제트룡 | Garchomp | 드래곤 / 땅 | 4 |
| 0658 | 물닌자 | Greninja | 물 / 악 | 6 |

## 포켓몬 추가하기

`data/pokemon.json` 의 `pokemon` 배열에 항목을 하나 더 넣고 서버를 재시작하면 된다.
스프라이트는 `public/sprites/<id>.png`, 일러스트는 `public/sprites/artwork/<id>.png` 로 넣는다.
새로운 타입을 쓰면 `types` 사전에 한글 이름도 같이 추가한다.

## PokeAPI 버전과 달라진 점

- GraphQL 쿼리 2개(`INDEX_QUERY`/`DETAIL_QUERY`)와 `gqlRequest()` → REST `apiGet()` 한 함수로 정리
- 스프라이트를 GitHub raw CDN 대신 서버가 직접 서빙 → 오프라인에서도 동작
- 앱은 `API_BASE` 를 상대 경로로 쓴다. 정적 파일만 따로 열 때는
  `index.html?api=http://localhost:3000` 처럼 서버 주소를 넘길 수 있다(CORS 허용해 둠).
