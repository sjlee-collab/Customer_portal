// L2 정적 스모크 — index.html을 실행 없이 검사한다 (의존성 0, 로그인 불필요).
//
// 사용: node scripts/harness/l2-smoke.mjs [index.html 경로]
// 종료코드: 통과 0 / 실패 1 (run-regression.sh 앞단에서 자동 실행)
//
// 왜: index.html은 660KB 단일 SPA인데 빌드·린트가 없어 문법 오류 하나가 화면 전체를
//     죽여도 커밋 전에 잡을 방법이 콘솔 붙여넣기(수동)뿐이었다. 헤드리스 브라우저는
//     의존성 설치가 필요해(npm 없음 정책) 정적 검사로 최대치를 잡는다:
//
//   1) <script> 블록별 문법 컴파일(vm) — 오타·괄호 불일치 등 파싱 단계 오류
//   2) HTML 인라인 핸들러(onclick 등)가 부르는 함수가 정의돼 있는지 — 함수 리네임 누락
//   3) JS의 getElementById/querySelector('#id') 리터럴이 실제 id로 존재하는지 — DOM 리네임 누락
//   4) 수동 스모크(scripts/smoke-frontend.js)가 확인하는 함수·DOM id 목록을 그대로 읽어
//      정의 여부를 검사 — 수동 체크리스트와 단일 출처
//
// 한계(정직하게): 실행하지 않으므로 런타임 오류(undefined 접근, 잘못된 데이터 바인딩)와
// 렌더 결과는 못 본다. 그건 여전히 수동 L2(콘솔 붙여넣기)나 향후 헤드리스(P5) 몫.
// 동적 id(문자열 조립)는 검사 대상에서 자연히 빠진다(리터럴만 매칭 — 오탐 방지).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = process.argv[2] || path.join(here, '..', '..', 'index.html');
const smokePath = path.join(here, '..', 'smoke-frontend.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const results = [];
const t = (name, cond, detail = '') =>
  results.push({ ok: !!cond, name, detail });

// ── 1) <script> 블록 문법 컴파일 ─────────────────────────────────────────────
const scripts = [];
{
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue;               // 외부 스크립트(현재 없음)는 제외
    const line = html.slice(0, m.index).split('\n').length;
    scripts.push({ code: m[2], line });
  }
}
t('<script> 블록 존재', scripts.length > 0, scripts.length + '개');
const js = scripts.map(s => s.code).join('\n');
for (const s of scripts) {
  try {
    new vm.Script(s.code, { filename: `index.html:<script>@${s.line}` });
    t(`문법 OK — <script> @${s.line}행 (${(s.code.length / 1024).toFixed(0)}KB)`, true);
  } catch (e) {
    t(`문법 오류 — <script> @${s.line}행`, false, String(e.message).split('\n')[0]);
  }
}

// ── 정의된 전역 함수 이름 수집 (function f( / window.f = / const|let|var f = ) ──
const defined = new Set();
for (const re of [
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
]) { let m; while ((m = re.exec(js))) defined.add(m[1]); }

// ── 2) HTML 인라인 핸들러 → 함수 정의 대조 ──────────────────────────────────
{
  const htmlNoScript = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // JS 키워드·전역/메서드 호출은 함수 참조가 아니다 — `.` 뒤(메서드)도 제외
  const NOT_FN = new Set(['if', 'for', 'while', 'switch', 'return', 'new', 'typeof', 'catch',
                          'function', 'else', 'in', 'of', 'alert', 'confirm', 'event', 'this']);
  const called = new Set();
  const attrRe = /\bon(?:click|change|input|submit|keyup|keydown|load|blur|focus)\s*=\s*(["'])([\s\S]*?)\1/g;
  let m;
  while ((m = attrRe.exec(htmlNoScript))) {
    const body = m[2];
    const idRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;   // 앞이 `.`이면 메서드 호출 — 제외
    let c; while ((c = idRe.exec(body))) if (!NOT_FN.has(c[2])) called.add(c[2]);
  }
  const missing = [...called].filter(f => !defined.has(f));
  t(`인라인 핸들러 ${called.size}종 전부 정의됨`, missing.length === 0, missing.length ? '미정의: ' + missing.join(', ') : '');
}

// ── 3) JS의 id 리터럴 참조 → HTML id 대조 ───────────────────────────────────
{
  const ids = new Set();
  {
    // 런타임 생성 마크업(문자열 안의 id=)도 포함해 전체 파일에서 수집 — 오탐 방지
    const re = /\bid\s*=\s*(?:["']|\\")([\w-]+)/g;
    let m; while ((m = re.exec(html))) ids.add(m[1]);
  }
  const refs = new Set();
  for (const re of [
    /getElementById\(\s*['"`]([\w-]+)['"`]\s*\)/g,
    /querySelector(?:All)?\(\s*['"`]#([\w-]+)['"`]\s*\)/g,
  ]) { let m; while ((m = re.exec(js))) refs.add(m[1]); }
  // 과거 리팩터 잔재 — 요소는 제거됐지만 if(el) 가드가 있거나 사장(dead) 코드라 무해함을
  // 2026-09-01 전수 확인함(레거시 Supabase 함수 포함). 코드를 정리하면 여기서도 지울 것.
  // 새로 생기는 죽은 참조는 이 목록에 없으므로 실패로 잡힌다.
  const BASELINE_DEAD = new Set(['rd-admin-controls', 'rd-due-col', 'ticket-history-timeline',
                                 'd-extra-msg', 'dash-license-val', 'dash-license-sub', 'co-email-notify']);
  const missing = [...refs].filter(id => !ids.has(id) && !BASELINE_DEAD.has(id));
  const cleaned = [...BASELINE_DEAD].filter(id => !refs.has(id) || ids.has(id));
  if (cleaned.length) t('베이스라인 정리 가능(참조 사라짐/요소 복원)', true, cleaned.join(', '));
  t(`JS가 참조하는 DOM id ${refs.size}개 전부 존재(베이스라인 ${BASELINE_DEAD.size}건 제외)`, missing.length === 0,
    missing.length ? '없는 id: ' + missing.join(', ') : '');
}

// ── 4) 수동 스모크 체크리스트(smoke-frontend.js)의 함수·id 정의 대조 ─────────
if (fs.existsSync(smokePath)) {
  const smoke = fs.readFileSync(smokePath, 'utf8');
  const fns = [...smoke.matchAll(/\bfn\(\s*'([\w$]+)'\s*\)/g)].map(m => m[1]);
  const missFn = fns.filter(f => !defined.has(f));
  t(`수동 스모크 대상 함수 ${fns.length}종 정의됨`, missFn.length === 0,
    missFn.length ? '미정의: ' + missFn.join(', ') : fns.join(', '));
  const domIds = [...smoke.matchAll(/'#?([\w-]+)'/g)].map(m => m[1])
    .filter(x => /-/.test(x));                            // 'f-product' 같은 id 후보만
  const missId = domIds.filter(id => !new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(html));
  t(`수동 스모크 대상 DOM id 정의됨`, missId.length === 0,
    missId.length ? '없는 id: ' + missId.join(', ') : '');
} else {
  t('smoke-frontend.js 존재', false, smokePath);
}

// ── 보고 ────────────────────────────────────────────────────────────────────
const fails = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
console.log(fails.length ? `❌ L2 정적 스모크 ${fails.length}건 실패 — ${path.basename(htmlPath)}`
                         : `✅ L2 정적 스모크 통과 (${results.length}건) — ${path.basename(htmlPath)}`);
process.exit(fails.length ? 1 : 0);
