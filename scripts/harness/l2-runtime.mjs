// L2 런타임 스모크 — 헤드리스 크로미움으로 index.html을 실제로 띄워 검증한다(P5).
// l2-smoke.mjs(정적)가 못 보는 런타임 오류(콘솔 에러·렌더 실패·로그인 후 화면)를 잡는다.
//
// 단독 실행이 아니라 tests/test_l2_runtime.py가 픽스처(테스트 계정)를 만들고 이 러너를
// 호출한다. 입력은 env: L2R_EMAIL / L2R_PW (로그인 검증용 — 없으면 로그인 단계 생략).
// 출력: 마지막 줄에 JSON 한 줄({checks:[{name,ok,detail}...]}) — 파이썬이 파싱해 단언.
//
// 페이지는 로컬 정적 서버로 서빙한다(file://는 fetch·경로가 깨짐). API 호출은 페이지의
// API_BASE(실 운영 API GW)로 나간다 — 로그인은 실제 요청이므로 반드시 [테스트] 계정만.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');          // 워크트리 루트(index.html 위치)
const SMOKE = path.join(here, 'smoke-frontend.js');
const EMAIL = process.env.L2R_EMAIL || '';
const PW = process.env.L2R_PW || '';

const checks = [];
const t = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });

// ── 정적 서버(워크트리 루트) ──
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html');
  fs.readFile(p.endsWith(path.sep) ? path.join(p, 'index.html') : p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

// 페이지를 127.0.0.1에서 서빙하므로 실 API GW(운영 오리진만 허용)로 가는 fetch가 CORS로
// 막힌다. L2 런타임은 CORS 정책이 아니라 프론트 렌더를 검증하므로 웹 보안을 꺼 실 응답을
// 그대로 흐르게 한다(Python 경로인 test_jwt가 CORS와 무관하게 API 계약을 이미 검증).
// 브라우저 실행 실패(바이너리 부재 등 — 예: 작업 스케줄러 환경에서 경로 해석 어긋남)는
// 제품 결함이 아니므로 '실패'가 아니라 '건너뜀'으로 신호한다(REALFAIL 오탐 방지).
let browser;
try {
  browser = await chromium.launch({
    args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
  });
} catch (e) {
  const msg = String((e && e.message) || e).split('\n')[0].slice(0, 200);
  console.log('L2R_SKIP: chromium 실행 불가 — ' + msg);
  console.log(JSON.stringify({ skip: true, reason: msg }));
  server.close();
  process.exit(0);
}
try {
  const page = await browser.newPage();
  const errors = [];   // 콘솔 error + 페이지 예외 수집
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  // ── 1) 페이지 로드 + 콘솔 에러 0 ──
  await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);   // 초기 스크립트·리소스 정착
  t('페이지 로드', true, URL_);
  // 정적 서버라 CSP 헤더가 없고, 외부(API GW) fetch는 로그인 전엔 발생 안 함 — 순수 부팅 에러만 잡힘
  const bootErrors = errors.filter(e => !/favicon/.test(e));
  t('부팅 콘솔 에러 0', bootErrors.length === 0, bootErrors.slice(0, 3).join(' | '));

  // ── 2) 로그인 화면 렌더 확인 ──
  t('로그인 화면 표시', await page.locator('#screen-login').isVisible());
  t('메인 화면 숨김', !(await page.locator('#screen-main').isVisible()));

  // ── 3) 수동 스모크(smoke-frontend.js) 자동 주입 — 사람이 콘솔에 붙여넣던 것 ──
  const smokeSrc = fs.readFileSync(SMOKE, 'utf8');
  const fails = await page.evaluate(src => { return eval(src); }, smokeSrc);
  t('smoke-frontend 통과', Array.isArray(fails) && fails.length === 0,
    Array.isArray(fails) ? fails.slice(0, 3).join(' | ') : 'eval 결과 비정상');

  // ── 4) 실로그인 → 메인 화면 (P4로 허용된 테스트 계정만) ──
  if (EMAIL && PW) {
    errors.length = 0;
    await page.fill('#login-email', EMAIL);
    await page.fill('#login-pw', PW);
    await page.click('button:has-text("로그인")');
    // 로그인 성공 = 메인 화면 표시
    let mainShown = false;
    try { await page.waitForSelector('#screen-main', { state: 'visible', timeout: 15000 }); mainShown = true; }
    catch { /* 실패 시 아래에서 login-error 내용 첨부 */ }
    const loginErr = await page.locator('#login-error').textContent().catch(() => '');
    t('실로그인 → 메인 화면 전환', mainShown, mainShown ? '' : ('login-error: ' + (loginErr || '').trim()));
    if (mainShown) {
      await page.waitForTimeout(2500);   // 대시보드 데이터 로드(실 API 왕복)
      // 고객 홈 핵심 렌더 — 최근 요청 테이블 골격 존재
      t('홈 핵심 DOM 렌더', await page.locator('#dash-recent-tbody').count() > 0);
      const postErrors = errors.filter(e => !/favicon/.test(e));
      t('로그인 후 콘솔 에러 0', postErrors.length === 0, postErrors.slice(0, 3).join(' | '));
    }
  } else {
    t('실로그인 단계', true, '건너뜀(L2R_EMAIL 미설정 — 비로그인 검사만)');
  }
} finally {
  await browser.close();
  server.close();
}

const failCount = checks.filter(c => !c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
console.log(JSON.stringify({ checks, fail: failCount }));
process.exit(failCount ? 1 : 0);
