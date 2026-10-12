// ========================================
// 가구 사진 생성 스크립트 (fal.ai · Seedream 5.0 Lite)
// ----------------------------------------
// 실행: node --env-file=.env generate-images.js
// - API 키는 .env 의 FAL_KEY 에서만 읽는다 (브라우저·코드에 키를 두지 않기 위해 미리 생성)
// - 이미 images/ 에 있는 파일은 건너뛴다 → 실패한 것만 다시 돌리면 됨
// - fal 이 돌려주는 파일은 JPEG(약 400KB)라 별도 압축 없이 바로 쓴다
// ========================================

const fs = require('fs');
const path = require('path');

const QUEUE = 'https://queue.fal.run/bytedance/seedream/v5/lite/text-to-image';
const OUT_DIR = path.join(__dirname, 'images');

// 모든 사진이 한 카탈로그처럼 보이도록 배경·조명 묘사를 공통으로 붙인다
const STYLE =
  'minimal editorial furniture catalog photograph, placed in a bright warm-white studio, ' +
  'soft natural window light from the left, beige lime-plaster wall, pale light oak floor, ' +
  'soft realistic shadows, Japandi and Scandinavian aesthetic, muted neutral palette, ' +
  'centered composition with generous empty space, high-end product photography, ' +
  'no text, no logo, no people';

const IMAGES = [
  { file: 'hero', size: 'landscape_16_9',
    subject: 'a calm minimal living room with a low cream linen sofa, a round travertine coffee table, a paper floor lamp and a small olive tree in a ceramic pot, wide interior shot' },
  { file: 'lounge-chair', subject: 'a solid oak lounge chair with a natural woven paper-cord seat' },
  { file: 'linen-sofa', subject: 'a low three-seater sofa upholstered in oatmeal linen with deep soft cushions' },
  { file: 'dining-table', subject: 'a solid walnut oval dining table with rounded legs' },
  { file: 'dining-chair', subject: 'a pair of light ash wood dining chairs with curved backrests' },
  { file: 'coffee-table', subject: 'a round travertine stone coffee table on a thick cylindrical base' },
  { file: 'side-table', subject: 'a small round oak side table with a ceramic vase on top' },
  { file: 'ottoman', subject: 'a round ivory boucle ottoman pouf' },
  { file: 'bookshelf', subject: 'a slim open oak bookshelf with a few books and ceramic objects' },
  { file: 'sideboard', subject: 'a long low oak sideboard with fluted sliding doors' },
  { file: 'bed-frame', subject: 'a low platform bed frame in natural oak with white linen bedding' },
  { file: 'floor-lamp', subject: 'a tall white rice-paper floor lamp glowing softly' },
  { file: 'pendant-lamp', subject: 'a large white paper pendant lamp hanging above a small oak table' },
];

async function generate({ file, subject, size = 'portrait_4_3' }) {
  const out = path.join(OUT_DIR, `${file}.jpg`);
  if (fs.existsSync(out)) return console.log(`· 건너뜀 ${file}`);

  const headers = { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };

  // 큐에 제출 → 상태 폴링 → 결과 조회
  // (동기 엔드포인트 fal.run 은 동시 요청 제한에 걸리면 바로 429 로 실패하지만, 큐는 차례를 기다려 준다)
  const submit = await fetch(QUEUE, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: `${subject}, ${STYLE}`, image_size: size, num_images: 1 }),
  });
  if (!submit.ok) throw new Error(`${file}: HTTP ${submit.status} ${await submit.text()}`);
  const { status_url, response_url } = await submit.json();

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { status } = await (await fetch(status_url, { headers })).json();
    if (status === 'COMPLETED') break;
    if (i === 119) throw new Error(`${file}: 6분 안에 끝나지 않음 (마지막 상태 ${status})`);
  }

  const result = await fetch(response_url, { headers });
  if (!result.ok) throw new Error(`${file}: 결과 조회 실패 HTTP ${result.status} ${await result.text()}`);
  const { images } = await result.json();
  const img = await fetch(images[0].url);
  fs.writeFileSync(out, Buffer.from(await img.arrayBuffer()));
  console.log(`✓ 저장 ${file}.jpg`);
}

async function main() {
  if (!process.env.FAL_KEY) throw new Error('.env 에 FAL_KEY 가 없습니다');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 동시에 2장씩 제출 (계정 동시 요청 제한이 10개라 넉넉히 낮춤)
  const queue = [...IMAGES];
  const failed = [];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await generate(item); } catch (e) { failed.push(item.file); console.error(`✗ ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: 2 }, worker));
  if (failed.length) console.log(`실패: ${failed.join(', ')} — 다시 실행하면 이것만 재시도합니다`);
}

main();
