const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// 문의 내용을 txt 로 쌓아 두는 폴더 (없으면 만든다)
const CONTACT_DIR = process.env.CONTACT_DIR || path.join(__dirname, 'contacts');

// ── In-memory store ──────────────────────────
// 접수 목록은 메모리에도 들고 있고(재시작 시 초기화), 원본은 txt 파일로 남는다.
let contacts = [];
let nextId = 1;

const CATEGORIES = ['제휴 문의', '채용 문의', '제품 문의', '기타'];

// ── Helpers ──────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

function formatDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 파일명에 쓸 수 없는 문자를 제거한다 (Windows 기준).
function safeFileName(text) {
  return String(text).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 20) || 'noname';
}

function buildFileName(id, name, d) {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${String(id).padStart(3, '0')}-${safeFileName(name)}.txt`;
}

function buildFileBody(contact) {
  return [
    '=========================================',
    '  포켓몬 컴퍼니 문의 접수',
    '=========================================',
    `문의 번호 : ${contact.id}`,
    `접수 일시 : ${contact.receivedAt}`,
    `이름      : ${contact.name}`,
    `이메일    : ${contact.email}`,
    `문의 유형 : ${contact.category}`,
    '-----------------------------------------',
    contact.message,
    '',
  ].join('\r\n');
}

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ───────────────────────────────

// 폼에서 쓰는 문의 유형 목록
app.get('/api/categories', (_req, res) => {
  res.json({ success: true, data: CATEGORIES });
});

// 접수된 문의 목록 (내용 미리보기까지만)
app.get('/api/contacts', (_req, res) => {
  res.json({
    success: true,
    data: contacts.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      receivedAt: c.receivedAt,
      file: c.file,
    })),
  });
});

// 문의 접수 → txt 파일로 저장
app.post('/api/contacts', (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const category = String(body.category || '').trim();
    const message = String(body.message || '').trim();

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: '이름, 이메일, 문의 내용은 필수입니다' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: '이메일 형식이 올바르지 않습니다' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: '문의 유형을 다시 선택해 주세요' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ success: false, message: '문의 내용은 2000자를 넘을 수 없습니다' });
    }

    const now = new Date();
    const contact = {
      id: nextId++,
      name,
      email,
      category,
      message,
      receivedAt: formatDateTime(now),
    };
    contact.file = buildFileName(contact.id, name, now);

    fs.mkdirSync(CONTACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONTACT_DIR, contact.file), buildFileBody(contact), 'utf8');

    contacts.push(contact);

    res.status(201).json({
      success: true,
      data: { id: contact.id, receivedAt: contact.receivedAt, file: contact.file },
    });
  } catch (err) {
    // 쓰기 권한이 없는 환경(서버리스 등)에서는 저장 자체가 실패한다.
    if (err && (err.code === 'EROFS' || err.code === 'EACCES')) {
      return res.status(500).json({ success: false, message: '서버에 파일을 저장할 수 없습니다 (쓰기 권한 없음)' });
    }
    next(err);
  }
});

// 등록되지 않은 API 경로는 index.html 대신 JSON 404
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Pokemon Company site running on http://localhost:${PORT}`);
    console.log(`문의 저장 위치: ${CONTACT_DIR}`);
  });
}
module.exports = app;
