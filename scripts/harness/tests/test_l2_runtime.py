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
import sys, os, json, subprocess
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dpost, ddel, api, tname, temail, Checker

HDIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def playwright_ready():
    r = subprocess.run(['node', '-e', "require.resolve('playwright')"],
                       capture_output=True, cwd=HDIR)
    return r.returncode == 0


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

        env = dict(os.environ, L2R_EMAIL=temail('l2rt'), L2R_PW=PW, PYTHONIOENCODING='utf-8')
        r = subprocess.run(['node', os.path.join(HDIR, 'l2-runtime.mjs')],
                           capture_output=True, text=True, encoding='utf-8', cwd=HDIR, env=env, timeout=120)
        out = (r.stdout or '').strip().splitlines()
        # 마지막 JSON 줄 파싱 — 없으면 러너 자체가 죽은 것
        payload = None
        for ln in reversed(out):
            if ln.startswith('{'):
                try: payload = json.loads(ln); break
                except Exception: pass
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
