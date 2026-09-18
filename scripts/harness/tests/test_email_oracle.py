"""L1 백엔드 계약 테스트 — 이메일 존재 오라클 차단 (public-inquiry / api-layer login·request-reset).

실행: python scripts/harness/tests/test_email_oracle.py
배경(2026-09-18, B안): 비인증 화면 세 곳이 "이 이메일이 가입돼 있나"를 그대로 답했다 —
  계정 신청 폼의 check-email(exists true/false)·제출 409, 로그인 404/401 구분, 재설정 요청 404.
  피싱 표적 선별·비번 대입 표적 압축에 쓰이는 정보라 전부 균일 응답으로 바꾸고, 실제 안내는
  그 주소의 우편함(ACCOUNT_EXISTS 메일)으로만 보낸다.
검증:
  - check-email: 등록된 이메일에도 exists:false (스텁)
  - 기존(활성) 이메일로 신청 → 200 {ok:true} (exists 키 없음) + users.exists_notified_at 기록
  - 같은 주소 재신청(15분 안) → 여전히 200, exists_notified_at 불변(쿨다운 — 메일 1통)
  - 허니팟 → 200 (기존 동작 유지)
  - 로그인: 미등록 이메일과 틀린 비밀번호가 **같은 401·같은 error 문구**
  - 비활성 계정 로그인 → 같은 401·같은 문구 / 재설정 요청 → 200이지만 재설정 메일 로그 없음
  - 미등록 이메일 재설정 요청 → 200
주의: 성공 로그인은 하지 않는다(login_events 오염). 기존 이메일 신청은 send-email ACCOUNT_EXISTS를
      비동기 호출한다 — 대상이 temail() 싱크이고 company가 [테스트]라 백스톱이 실 수신자를 막는다.
      새 이메일(미가입)로는 신청하지 않는다 — account_inquiries 행은 data-api로 지울 수 없다.
데이터: [테스트] 회사+고객, 종료 시 삭제.
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import api, invoke, dget, dpost, dpatch, ddel, tname, temail, must_id, Checker

FAIL_MSG = '이메일 또는 비밀번호가 올바르지 않습니다.'


def _inquiry(body):
    e = {'requestContext': {'http': {'method': 'POST'}}, 'rawPath': '/public/account-inquiry',
         'body': json.dumps(body, ensure_ascii=False)}
    return invoke('inquiry', e)


def _notified_at(uid):
    rows = dget('users', {'select': 'exists_notified_at', 'id': 'eq.' + uid}, role='admin').get('body') or []
    return (rows[0] if rows else {}).get('exists_notified_at')


def _reset_mails(email):
    rows = dget('log_notification', {'select': 'id', 'channel': 'eq.email', 'recipient': 'eq.' + email,
                                     'limit': '200'}, role='admin').get('body') or []
    return len(rows)


def run():
    t = Checker('L1 이메일 존재 오라클 차단')
    co_id = uid = None
    email = temail('oracle')
    try:
        co_id = must_id(dpost('companies', {'name': tname('오라클회사')}, role='admin'), '회사')
        uid = must_id(dpost('users', {'name': tname('오라클고객'), 'email': email, 'role': 'customer',
                                       'company_id': co_id, 'is_active': True}, role='admin'), '사용자')
        r0 = api('PATCH', '/auth/change-password', {'newPassword': 'Oracle!234'}, role='customer', userId=uid)
        t.check('초기 비밀번호 설정 200', r0.get('status') == 200, 'status=%s' % r0.get('status'))

        # ── 계정 신청 폼 ──
        ce = _inquiry({'action': 'check-email', 'email': email})
        t.check('check-email: 등록 이메일에도 exists:false',
                ce.get('status') == 200 and (ce.get('body') or {}).get('exists') is False,
                'status=%s body=%s' % (ce.get('status'), ce.get('body')))
        form = {'name': tname('오라클신청'), 'company': tname('오라클회사'), 'phone': '010-0000-0000', 'email': email}
        r1 = _inquiry(form)
        b1 = r1.get('body') or {}
        t.check('기존 이메일 신청 → 200 {ok:true} (409/exists 없음)',
                r1.get('status') == 200 and b1.get('ok') is True and 'exists' not in b1,
                'status=%s body=%s' % (r1.get('status'), b1))
        first = _notified_at(uid)
        t.check('exists_notified_at 기록됨(안내 메일 1통)', bool(first), 'value=%s' % first)
        r2 = _inquiry(form)
        second = _notified_at(uid)
        t.check('재신청도 200 + exists_notified_at 불변(쿨다운)', r2.get('status') == 200 and second == first,
                'status=%s first=%s second=%s' % (r2.get('status'), first, second))
        hp = _inquiry(dict(form, website='bot'))
        t.check('허니팟 200 유지', hp.get('status') == 200, 'status=%s' % hp.get('status'))

        # ── 로그인: 미등록 vs 틀린 비번 동일 ──
        ln = api('POST', '/auth/login', {'email': '__no_such_user__@example.com', 'password': 'x'})
        lw = api('POST', '/auth/login', {'email': email, 'password': 'wrong-pw'})
        t.check('미등록 이메일 로그인 401', ln.get('status') == 401, 'status=%s' % ln.get('status'))
        t.check('미등록·비번오류 응답 동일(status+body)',
                ln.get('status') == lw.get('status') == 401 and ln.get('body') == lw.get('body')
                and (lw.get('body') or {}).get('error') == FAIL_MSG,
                'no_user=%s wrong=%s' % (ln.get('body'), lw.get('body')))

        # ── 재설정 요청: 미등록 200 ──
        rq = api('POST', '/auth/request-reset', {'email': '__no_such_user__@example.com'})
        t.check('미등록 이메일 재설정 요청 200', rq.get('status') == 200 and (rq.get('body') or {}).get('ok') is True,
                'status=%s body=%s' % (rq.get('status'), rq.get('body')))

        # ── 비활성 계정: 로그인 동일 401 / 재설정 200이지만 메일 없음 ──
        dpatch('users', uid, {'is_active': False}, role='admin')
        li = api('POST', '/auth/login', {'email': email, 'password': 'Oracle!234'})
        t.check('비활성 계정 정답 로그인도 같은 401·문구',
                li.get('status') == 401 and (li.get('body') or {}).get('error') == FAIL_MSG,
                'status=%s body=%s' % (li.get('status'), li.get('body')))
        before = _reset_mails(email)
        ri = api('POST', '/auth/request-reset', {'email': email})
        t.check('비활성 계정 재설정 요청 200', ri.get('status') == 200, 'status=%s' % ri.get('status'))
        time.sleep(8)  # 메일이 갔다면 로그가 남을 시간
        after = _reset_mails(email)
        t.check('비활성 계정엔 재설정 메일 없음', after == before, 'before=%s after=%s' % (before, after))
    finally:
        if uid: ddel('users', uid, role='admin')
        if co_id: ddel('companies', co_id, role='admin')
    return t.report(min_checks=12)


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
