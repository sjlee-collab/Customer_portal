"""L1 백엔드 계약 테스트 — 인증(로그인/비밀번호 변경).

실행: python scripts/harness/tests/test_auth.py
검증:
  - 로그인 살아있음(순단 검출) + 분기: 미등록 404 / 틀린 비번 401
  - 비밀번호 변경 보안: currentPassword 없이·틀리면 거부, 맞으면 변경 → 옛 비번 로그인 거부(변경 반영)
  - 재설정 무효 토큰 거부
주의: 성공 로그인은 login_events를 남기고 itest로 지울 수 없어 오염되므로 하지 않는다.
      401/404는 login_events를 남기지 않으면서도 로그인 핸들러가 살아있음을 증명한다(순단이면 500).
데이터: [테스트] 회사+고객 1개(평문 초기비번, login이 legacy 평문도 허용), 종료 시 삭제.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import api, dpost, ddel, tname, temail, Checker


def run():
    t = Checker('L1 인증(login/비밀번호)')
    co_id = uid = None
    try:
        co = dpost('companies', {'name': tname('인증회사')}, role='admin').get('body')
        co_id = (co[0] if isinstance(co, list) else co or {}).get('id')
        # password는 data-api로 직접 쓸 수 없어(보안 통제), 초기 비번은 change-password의
        # "미설정 계정" 경로로 설정한다(관리자 신규 등록 계정과 동일한 상태에서 시작).
        u = dpost('users', {'name': tname('인증고객'), 'email': temail('authcust'), 'role': 'customer',
                            'company_id': co_id, 'is_active': True}, role='admin').get('body')
        uid = (u[0] if isinstance(u, list) else u or {}).get('id')
        t.check('테스트 계정 생성', bool(uid))
        rset = api('PATCH', '/auth/change-password', {'newPassword': 'InitPw!234'}, role='customer', userId=uid)
        t.check('초기 비밀번호 설정 200', rset.get('status') == 200, 'status=%s body=%s' % (rset.get('status'), rset.get('body')))

        # ── 로그인 살아있음(순단 검출) + 분기 ──
        r1 = api('POST', '/auth/login', {'email': '__no_such_user__@example.com', 'password': 'x'})
        t.check('미등록 이메일 404', r1.get('status') == 404, 'status=%s' % r1.get('status'))
        r2 = api('POST', '/auth/login', {'email': temail('authcust'), 'password': 'wrong-pw'})
        t.check('틀린 비밀번호 401', r2.get('status') == 401, 'status=%s' % r2.get('status'))

        # ── 비밀번호 변경 — currentPassword 서버 재확인(토큰만으로 탈취 방지) ──
        rc0 = api('PATCH', '/auth/change-password', {'newPassword': 'New!2345'}, role='customer', userId=uid)
        t.check('현재비번 누락 시 거부', rc0.get('status') not in (200, 204), 'status=%s' % rc0.get('status'))
        rc1 = api('PATCH', '/auth/change-password', {'currentPassword': 'wrong-pw', 'newPassword': 'New!2345'}, role='customer', userId=uid)
        t.check('현재비번 틀리면 거부', rc1.get('status') not in (200, 204), 'status=%s' % rc1.get('status'))
        rc2 = api('PATCH', '/auth/change-password', {'currentPassword': 'InitPw!234', 'newPassword': 'New!2345'}, role='customer', userId=uid)
        t.check('현재비번 맞으면 변경 200', rc2.get('status') == 200, 'status=%s body=%s' % (rc2.get('status'), rc2.get('body')))
        # 변경 반영 확인: 옛 비번으로 로그인하면 거부(401). (성공 로그인은 하지 않음 — login_events 오염 방지)
        r3 = api('POST', '/auth/login', {'email': temail('authcust'), 'password': 'InitPw!234'})
        t.check('변경 후 옛 비번 로그인 거부', r3.get('status') == 401, 'status=%s' % r3.get('status'))

        # ── 재설정 무효 토큰 거부 ──
        rr = api('POST', '/auth/reset-password', {'token': 'bogus-invalid-token', 'password': 'Zz!234567'})
        t.check('무효 재설정 토큰 거부', rr.get('status') not in (200, 204), 'status=%s' % rr.get('status'))
    finally:
        if uid: ddel('users', uid, role='admin')
        if co_id: ddel('companies', co_id, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
