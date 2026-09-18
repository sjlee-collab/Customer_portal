"""L2 런타임 스모크 — 헤드리스 크로미움으로 index.html 실동작 검증 (P5).

실행: python scripts/harness/tests/test_l2_runtime.py
배경: l2-smoke.mjs(정적)는 문법·참조만 본다. 이 스위트는 실제 브라우저로 페이지를
      띄워 런타임을 본다 — 부팅 콘솔 에러, 수동 스모크(smoke-frontend.js) 자동 주입,
      그리고 P4로 허용된 테스트 계정 실로그인 → 메인 화면 렌더까지.
      "문법은 멀쩡한데 화면이 하얗게 뜨는" 류의 사고를 잡는 마지막 수동 구간의 자동화.

구성: 이 파이썬이 픽스처(테스트 계정+비번)를 만들고 l2-runtime.mjs(playwright)를
      호출, 마지막 줄 JSON을 파싱해 단언한다. 브라우저 파트는 Node가 담당.

전제: scripts/harness에 playwright 설치(npm i playwright && npx playwright install chromium).
      미설치면 전체를 건너뛴다(⏭ 표시, 실패 아님) — 새 장비에서 회귀가 깨지지 않게.

로그인: 실 API로 나가는 진짜 로그인 — 반드시 temail 테스트 계정(P4: 통계·이력에서 제외).
"""
import sys, os, json, time, subprocess
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dpost, ddel, api, tname, temail, Checker

HDIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def playwright_ready():
    r = subprocess.run(['node', '-e', "require.resolve('playwright')"],
                       capture_output=True, cwd=HDIR)
    return r.returncode == 0


def pin_browsers_path(env):
    """playwright 브라우저 경로를 절대경로로 명시 고정한다.

    기본값은 %LOCALAPPDATA%\\ms-playwright인데, 작업 스케줄러(비대화형 로그온)에서는
    %LOCALAPPDATA% 해석이 어긋나 설치된 브라우저를 못 찾는 사례가 있었다(2026-09-04 새벽
    회귀 REALFAIL). 사용자 프로필에서 절대경로를 계산해 PLAYWRIGHT_BROWSERS_PATH로 넘겨
    대화형/스케줄러가 동일 경로를 보게 한다. 이미 설정돼 있으면 존중한다.
    """
    if not env.get('PLAYWRIGHT_BROWSERS_PATH'):
        # 워크트리 내부 사본 우선 — 스케줄러 실행 컨텍스트에서는 %LOCALAPPDATA%\ms-playwright
        # 폴더가 파이썬 레벨에서도 상시 안 보인다(2026-09-18 재현·확정: 부팅 시점 무관,
        # env는 정상인데 isdir=False). 워크트리(스크립트·node_modules)는 항상 보이므로
        # 브라우저를 scripts/harness/.pw-browsers 에 두면 새벽 실행에서도 l2가 돈다.
        local = os.path.join(HDIR, '.pw-browsers')
        base = env.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Local')
        for cand in (local, os.path.join(base, 'ms-playwright')):
            if os.path.isdir(cand):
                env['PLAYWRIGHT_BROWSERS_PATH'] = cand
                break
    return env


def _run_runner(env):
    r = subprocess.run(['node', os.path.join(HDIR, 'l2-runtime.mjs')],
                       capture_output=True, text=True, encoding='utf-8', cwd=HDIR, env=env, timeout=120)
    out = (r.stdout or '').strip().splitlines()
    payload = None
    for ln in reversed(out):
        if ln.startswith('{'):
            try:
                payload = json.loads(ln); break
            except Exception:
                pass
    return r, out, payload


def _diagnose_browser(env):
    """skip 원인 규명용 — 파이썬 쪽에서 본 브라우저 설치 상태를 로그로 남긴다.
    node(playwright)는 '없다'는데 파이썬은 '있다'고 보이면 접근권/스캔 지연 계열,
    파이썬도 '없다'면 진짜 미설치/경로 문제로 원인이 갈린다(스케줄러 간헐 실패 추적)."""
    base = env.get('PLAYWRIGHT_BROWSERS_PATH', '(미설정)')
    exists = os.path.isdir(base)
    exe = None
    if exists:
        for d in sorted(os.listdir(base)):
            cand = os.path.join(base, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
            if d.startswith('chromium_headless_shell') and os.path.isfile(cand):
                exe = cand
    print('  [진단] BROWSERS_PATH=%s 존재=%s / headless-shell.exe %s'
          % (base, exists, ('확인됨: ' + exe) if exe else '파이썬에서도 안 보임'))


def run():
    t = Checker('L2 런타임(헤드리스 브라우저)')
    if not playwright_ready():
        print('⏭ playwright 미설치 — L2 런타임 건너뜀'
              ' (설치: cd scripts/harness && npm i playwright && npx playwright install chromium)')
        return True
    co_id = uid = None
    PW = 'L2rt!2345'
    try:
        co = dpost('companies', {'name': tname('L2RT 회사'), 'status': 'active'})['body']
        co_id = co.get('id')
        u = dpost('users', {'email': temail('l2rt'), 'name': tname('L2RT고객'), 'role': 'customer',
                            'company_id': co_id, 'is_active': True})['body']
        uid = u.get('id')
        r = api('PATCH', '/auth/change-password', {'newPassword': PW}, role='customer', userId=uid)
        t.check('픽스처: 계정+비번', r.get('status') == 200, 'status=%s' % r.get('status'))

        env = pin_browsers_path(dict(os.environ, L2R_EMAIL=temail('l2rt'), L2R_PW=PW,
                                     PYTHONIOENCODING='utf-8'))
        r, out, payload = _run_runner(env)
        # 브라우저 실행 불가는 스케줄러의 부팅 직후 실행에서 간헐 재발한다(9-04·9-10·9-15 실측 —
        # 파일은 실재하는데 그 세션에서만 '없음'). 부팅 과도기(프로필/백신 첫 스캔) 추정이므로
        # 바로 포기하지 않고 진단 로그 + 20초 대기 후 1회 재시도한다.
        if payload and payload.get('skip'):
            print('  1차 브라우저 실행 불가(%s) — 진단 후 20초 뒤 재시도' % payload.get('reason', ''))
            _diagnose_browser(env)
            time.sleep(20)
            r, out, payload = _run_runner(env)
            if payload and not payload.get('skip'):
                print('  ↻ 재시도 성공 — 부팅 과도기 추정(1차 실패는 무해)')
        # 재시도도 불가면 실패가 아니라 건너뜀(REALFAIL 오탐 방지) — 단 SUMMARY·슬랙에 표면화된다.
        if payload and payload.get('skip'):
            print('⏭ L2 런타임 건너뜀 — 브라우저 실행 불가(재시도 포함 2회: %s)' % payload.get('reason', ''))
            return True
        t.check('브라우저 러너 정상 종료', payload is not None,
                'exit=%s tail=%s' % (r.returncode, (out[-2:] if out else r.stderr[:200])))
        for c in (payload or {}).get('checks', []):
            t.check(c['name'], c['ok'], c.get('detail', ''))
    finally:
        if uid: ddel('users', uid, role='admin')
        if co_id: ddel('companies', co_id, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
