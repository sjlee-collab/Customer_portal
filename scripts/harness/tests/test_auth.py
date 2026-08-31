"""L1 백엔드 계약 테스트 — 인증(로그인/비밀번호 변경).

실행: python scripts/harness/tests/test_auth.py
검증:
  - 로그인 살아있음(순단 검출) + 분기: 미등록 404 / 틀린 비번 401
  - 비밀번호 변경 보안: currentPassword 없이·틀리면 거부, 맞으면 변경 → 옛 비번 로그인 거부(변경 반영)
  - 재설정 무효 토큰 거부
  - 비밀번호 확인(/auth/verify-password): 맞으면 200, 틀리면 거부
  - 관리자 재설정(/auth/admin-reset-password): admin→고객 200(재설정 메일),
    userId 누락 400, 권한상승 차단(user_manage 가진 비관리자가 내부직원 대상 → 403)
  - 초대(/auth/invite): admin 200(초대 메일) / 미등록 이메일 404 / 고객 403(user_manage 없음)
  - 담당영업 조회(/my/account-manager): 고객 200 + {name,email} 구조
주의: 성공 로그인은 login_events를 남기고 itest로 지울 수 없어 오염되므로 하지 않는다.
      401/404는 login_events를 남기지 않으면서도 로그인 핸들러가 살아있음을 증명한다(순단이면 500).
메일 주의: admin-reset·invite는 실제 메일 경로다 — 대상이 temail() 싱크 계정이므로
      실행당 2통이 sjlee 싱크로 들어온다. 내부직원 계정은 메일이 나가기 전 403으로 차단되는
      경로만 검증한다.
데이터: [테스트] 회사+고객+내부직원(평문 초기비번, login이 legacy 평문도 허용), 종료 시 삭제.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import api, dpost, ddel, tname, temail, Checker


def run():
    t = Checker('L1 인증(login/비밀번호)')
    co_id = uid = staff_id = None
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

        # ── 비밀번호 확인(/auth/verify-password) — 현재 비번은 New!2345 ──
        rv = api('POST', '/auth/verify-password', {'password': 'New!2345'}, role='customer', userId=uid)
        t.check('비밀번호 확인 200', rv.get('status') == 200, 'status=%s' % rv.get('status'))
        rv = api('POST', '/auth/verify-password', {'password': 'wrong-pw'}, role='customer', userId=uid)
        t.check('비밀번호 확인 틀리면 거부', rv.get('status') not in (200, 204), 'status=%s' % rv.get('status'))

        # ── 관리자 재설정(/auth/admin-reset-password) ──
        staff = dpost('users', {'name': tname('인증직원'), 'email': temail('authstaff'), 'role': 'internal',
                                'is_active': True}, role='admin').get('body')
        staff_id = (staff[0] if isinstance(staff, list) else staff or {}).get('id')
        ra = api('POST', '/auth/admin-reset-password', {'userId': uid}, role='admin', userId='zz-admin')
        t.check('admin→고객 재설정 200', ra.get('status') == 200, 'status=%s body=%s' % (ra.get('status'), ra.get('body')))
        ra = api('POST', '/auth/admin-reset-password', {}, role='admin', userId='zz-admin')
        t.check('userId 누락 400', ra.get('status') == 400, 'status=%s' % ra.get('status'))
        # 권한상승 차단: user_manage를 가진 비관리자(admin이 아닌 역할)가 내부직원 대상 → 403
        ra = api('POST', '/auth/admin-reset-password', {'userId': staff_id}, role='internal', userId='zz-i')
        t.check('비관리자→내부직원 재설정 403', ra.get('status') == 403, 'status=%s' % ra.get('status'))

        # ── 초대(/auth/invite) ──
        ri = api('POST', '/auth/invite', {'email': temail('authcust')}, role='admin', userId='zz-admin')
        t.check('초대 200(등록 계정)', ri.get('status') == 200, 'status=%s body=%s' % (ri.get('status'), ri.get('body')))
        ri = api('POST', '/auth/invite', {'email': '__no_such__@example.com'}, role='admin', userId='zz-admin')
        t.check('초대 미등록 이메일 404', ri.get('status') == 404, 'status=%s' % ri.get('status'))
        ri = api('POST', '/auth/invite', {'email': temail('authcust')}, role='customer', userId=uid, companyId=co_id)
        t.check('초대 고객 403', ri.get('status') == 403, 'status=%s' % ri.get('status'))

        # ── 담당영업 조회(/my/account-manager) — 고객 200 + 구조 ──
        rm = api('GET', '/my/account-manager', None, role='customer', userId=uid, companyId=co_id)
        mb = rm.get('body') or {}
        t.check('담당영업 조회 200 + 구조', rm.get('status') == 200 and 'name' in mb and 'email' in mb,
                'status=%s keys=%s' % (rm.get('status'), sorted(mb)))
    finally:
        if staff_id: ddel('users', staff_id, role='admin')
        if uid: ddel('users', uid, role='admin')
        if co_id: ddel('companies', co_id, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
