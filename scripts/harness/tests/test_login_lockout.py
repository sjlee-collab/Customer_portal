"""L1 백엔드 계약 테스트 — 로그인 잠금·재설정 쿨다운 (api-layer login / request-reset).

실행: python scripts/harness/tests/test_login_lockout.py
검증:
  - 연속 5회 실패 → failed_logins=5 · locked_until 설정(약 15분 뒤)
  - 잠금 중에는 **정답 비밀번호도 401** (잠금이 카운터가 아니라 실제 차단임을 증명)
  - 잠금 중 시도는 카운터를 올리지 않는다(잠금 연장 DoS 방지)
  - 잠금 응답이 일반 실패와 동일(같은 401·같은 error 문구) — "잠겼다"를 알려주지 않음
  - 비밀번호 변경(현재 비번 증명) → 카운터·잠금 리셋 (사용자 자력 복구 경로)
  - 리셋 후 실패 1회 → failed_logins=1 (카운터가 다시 동작)
  - request-reset 2회 연속 → 둘 다 200이지만 재설정 메일은 1통만(쿨다운 15분)
주의: 성공 로그인은 login_events를 남겨 통계를 오염시키므로 하지 않는다 — 리셋 검증은
      change-password(인증 컨텍스트 직접 주입, 로그인 없음)로 한다. 잠금 중 정답 시도는
      401이라 login_events가 남지 않는다.
메일 주의: request-reset은 실제 메일 경로다 — 대상이 temail() 싱크라 실행당 1통이 싱크로 간다.
데이터: [테스트] 회사+고객, 종료 시 삭제.
"""
import sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import api, dget, dpost, ddel, tname, temail, must_id, Checker

PW_OK = 'LockPw!234'
PW_NEW = 'LockPw!235'
FAIL_MSG = '이메일 또는 비밀번호가 올바르지 않습니다.'  # 2026-09-18 균일화 문구(test_email_oracle과 동일)


def _lock_row(uid):
    rows = dget('users', {'select': 'failed_logins,locked_until', 'id': 'eq.' + uid}, role='admin').get('body') or []
    return rows[0] if rows else {}


def _reset_mails(email):
    rows = dget('log_notification',
                {'select': 'id,event_type,recipient', 'channel': 'eq.email',
                 'recipient': 'eq.' + email, 'limit': '200'}, role='admin').get('body') or []
    return len(rows)


def run():
    t = Checker('L1 로그인 잠금·재설정 쿨다운')
    co_id = uid = None
    email = temail('lockcust')
    try:
        co_id = must_id(dpost('companies', {'name': tname('잠금회사')}, role='admin'), '회사')
        uid = must_id(dpost('users', {'name': tname('잠금고객'), 'email': email, 'role': 'customer',
                                       'company_id': co_id, 'is_active': True}, role='admin'), '사용자')
        r0 = api('PATCH', '/auth/change-password', {'newPassword': PW_OK}, role='customer', userId=uid)
        t.check('초기 비밀번호 설정 200', r0.get('status') == 200, 'status=%s' % r0.get('status'))

        # ── 5회 연속 실패 → 잠금 ──
        statuses = []
        for _ in range(5):
            statuses.append(api('POST', '/auth/login', {'email': email, 'password': 'wrong-pw'}).get('status'))
        t.all_of('실패 5회 모두 401', statuses, lambda s: s == 401, min_n=5, detail='statuses=%s' % statuses)
        row = _lock_row(uid)
        t.check('failed_logins=5', row.get('failed_logins') == 5, 'row=%s' % row)
        t.check('locked_until 설정됨', bool(row.get('locked_until')), 'row=%s' % row)

        # ── 잠금 중 정답도 거부 + 응답이 일반 실패와 동일 + 카운터 불변 ──
        r_ok = api('POST', '/auth/login', {'email': email, 'password': PW_OK})
        t.check('잠금 중 정답 비밀번호 401', r_ok.get('status') == 401, 'status=%s' % r_ok.get('status'))
        t.check('잠금 응답 문구가 일반 실패와 동일', (r_ok.get('body') or {}).get('error') == FAIL_MSG,
                'body=%s' % r_ok.get('body'))
        row2 = _lock_row(uid)
        t.check('잠금 중 시도는 카운터 불변(5)', row2.get('failed_logins') == 5, 'row=%s' % row2)

        # ── 비밀번호 변경(현재 비번 증명) → 리셋 ──
        rc = api('PATCH', '/auth/change-password', {'currentPassword': PW_OK, 'newPassword': PW_NEW},
                 role='customer', userId=uid)
        t.check('잠금 중에도 change-password(현재비번 증명) 200', rc.get('status') == 200,
                'status=%s body=%s' % (rc.get('status'), rc.get('body')))
        row3 = _lock_row(uid)
        t.check('리셋 후 failed_logins=0', row3.get('failed_logins') == 0, 'row=%s' % row3)
        t.check('리셋 후 locked_until 해제', not row3.get('locked_until'), 'row=%s' % row3)

        # ── 리셋 후 카운터 재동작 ──
        r_again = api('POST', '/auth/login', {'email': email, 'password': 'wrong-pw'})
        row4 = _lock_row(uid)
        t.check('리셋 후 실패 1회 → failed_logins=1', r_again.get('status') == 401 and row4.get('failed_logins') == 1,
                'status=%s row=%s' % (r_again.get('status'), row4))

        # ── request-reset 쿨다운: 2회 연속 → 메일 1통 ──
        before = _reset_mails(email)
        rq1 = api('POST', '/auth/request-reset', {'email': email})
        rq2 = api('POST', '/auth/request-reset', {'email': email})
        t.check('request-reset 2회 모두 200', rq1.get('status') == 200 and rq2.get('status') == 200,
                'statuses=%s,%s' % (rq1.get('status'), rq2.get('status')))
        deadline = time.time() + 45
        n = before
        while time.time() < deadline:
            n = _reset_mails(email)
            if n >= before + 1:
                break
            time.sleep(3)
        time.sleep(5)  # 두 번째 메일이 늦게 오는지 잠시 더 본다
        n = _reset_mails(email)
        t.check('재설정 메일은 1통만(쿨다운)', n == before + 1, 'before=%s after=%s' % (before, n))
    finally:
        if uid: ddel('users', uid, role='admin')
        if co_id: ddel('companies', co_id, role='admin')
    return t.report(min_checks=10)


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
