# 주차별 작업 기록

| 주차 | 주제 | 결과물 |
|---|---|---|
| week-1 | Claude Code 입문, 문서 생성 | 레시피북(md→html/docx), 네이버 클론, 회고·자기소개 문서 |
| week-2 | 문서 다루기 + 단일 파일 웹앱 | PDF 질의, QR코드 생성기, 더치페이 계산기, 세금 계산기, 짤 생성기 |
| week-3 | Playwright MCP 브라우저 자동화 | 쿠팡·네이버·유튜브 스크린샷 자동화, 구글폼 자동 제출, 상담 페이지 |
| week-4 | Express 백엔드 + DB + 배포 | 포켓몬 도감, 할 일 앱, 메모 앱, 밸런스 게임, **냉장고 요리사(quest)** |
| week-5 | 집계 쿼리 + 시각화 | **가계부(`quest/Budget/`)** — 카테고리별 합계·월별 집계를 `GROUP BY` 로 집계, 도넛·막대 차트·교차표(히트맵) / **커뮤니티(`community/`)** — 회원가입·로그인(bcrypt + JWT) + 게시판·댓글 / **과자 쇼핑몰(`snack-shop/`)** — 장바구니·주문·회원(마이페이지), 트랜잭션으로 재고 차감 |
| week-6 | 에이전트 팀 구성 + AI 이미지 생성 | **가구 쇼핑몰(`class/furniture-shop/`)** — 단일 index.html(해시 라우팅·장바구니·데모 주문) + 상품·회원 DB(`furniture_products`·`furniture_users`), 이메일·비밀번호 로그인(bcrypt + JWT), 제품 사진은 fal.ai Seedream 5.0으로 미리 생성 / `class/agent-team-examples/` 에이전트 조직 예제 / **모의투자 리그(`quest/stock-sim/`)** — 닉네임 참가(bcrypt + JWT)로 참가자별 계좌, 수익률 순위 현황판 + Yahoo Finance 실시간 시세로 원화·달러 모의 매매(트랜잭션 + `FOR UPDATE`), OpenAI 종목 분석을 분석 시점 가격과 함께 기록해 적중률 비교 |

week-4의 `class/`에는 yt-dlp로 받은 영상 자막을 트랜스크립트·요약 마크다운으로
정리한 결과물도 있습니다(`*-transcript.md` / `*-summary.md`). 원본 미디어는 용량 때문에
`.gitignore`로 제외됩니다.
