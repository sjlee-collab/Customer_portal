"""L1 백엔드 계약 테스트 — JWT 폐기(users.token_version ↔ 토큰 ver 클레임 대조).

실행: python scripts/harness/tests/test_token_version.py
검증:
  - 컨텍스트에 tokenVersion 키가 없으면(직접 invoke·하네스) 대조를 건너뛴다(기존 스위트 호환)
  - tokenVersion='0'(기본값·구토큰) → 200
  - tokenVersion 불일치 → **401 + error 키 없음**(인가자와 같은 모양 → 프론트가 세션 만료로 처리)
  - data-api·api-layer 양쪽 모두 대조
  - change-password → token_version +1 + **새 토큰 반환**(B안), 새 토큰 ver == 1, 옛 버전은 401
  - /auth/logout → +1 (전 기기 폐기), 옛 버전 401 · 다음 버전 200
  - 관리자가 role/is_active 변경 → +1 (data-api PATCH bump)
  - is_active=false → 어떤 버전이든 401
  - token_version은 data-api로 읽기·쓰기·필터 불가(BLOCKED_COLUMNS)
주의: 실제 로그인은 하지 않는다(login_events 오염) — 컨텍스트 주입으로 검증. 메일 발송 없음.
데이터: [테스트] 회사+고객, 종료 시 삭제.
"""
import sys, os, json, base64
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import api, dget, dpost, dpatch, ddel, tname, temail, must_id, Checker

PW = 'TokenPw!234'
PW2 = 'TokenPw!235'


def _jwt_payload(token):
    part = token.split('.')[1]
    part += '=' * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part).decode('utf-8'))


def _bare401(r):
    b = r.get('body')
    return r.get('status') == 401 and isinstance(b, dict) and 'error' not in b and b.get('message') == 'Unauthorized'


def run():
    t = Checker('L1 토큰 폐기(token_version)')
    co_id = uid = None
    try:
        co_id = must_id(dpost('companies', {'name': tname('토큰회사')}, role='admin'), '회사')
        uid = must_id(dpost('users', {'name': tname('토큰고객'), 'email': temail('tokenver'), 'role': 'customer',
                                       'company_id': co_id, 'is_active': True}, role='admin'), '사용자')
        C = dict(userId=uid, companyId=co_id)
        r0 = api('PATCH', '/auth/change-password', {'newPassword': PW}, role='customer', **C)
        t.check('초기 비밀번호 설정 200', r0.get('status') == 200, 'status=%s' % r0.get('status'))
        # 초기 설정도 change-password라 token_version은 이미 1이다(응답에 새 토큰 포함).
        tok0 = (r0.get('body') or {}).get('token')
        t.check('초기 설정 응답에 새 토큰 포함', bool(tok0), 'keys=%s' % sorted((r0.get('body') or {}).keys()))
        v = _jwt_payload(tok0).get('ver') if tok0 else None
        t.check('토큰 ver 클레임 == 1', v == 1, 'ver=%s' % v)

        # ── 대조 규칙 (data-api) ──
        q = {'select': 'id', 'id': 'eq.' + uid, 'limit': '1'}
        r = dget('users', q, role='customer', **C)
        t.check('키 없음(직접 invoke) → 대조 생략 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        r = dget('users', q, role='customer', tokenVersion=1, **C)
        t.check('일치(1) → 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        r = dget('users', q, role='customer', tokenVersion=0, **C)
        t.check('구버전(0) → 401 bare', _bare401(r), 'status=%s body=%s' % (r.get('status'), r.get('body')))
        r = dget('users', q, role='customer', tokenVersion=7, **C)
        t.check('불일치(7) → 401 bare', _bare401(r), 'status=%s body=%s' % (r.get('status'), r.get('body')))

        # ── 대조 규칙 (api-layer) ──
        r = api('GET', '/my/account-manager', None, role='customer', tokenVersion=1, **C)
        t.check('api-layer 일치 → 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        r = api('GET', '/my/account-manager', None, role='customer', tokenVersion=0, **C)
        t.check('api-layer 불일치 → 401 bare', _bare401(r), 'status=%s body=%s' % (r.get('status'), r.get('body')))

        # ── 비밀번호 변경 → +1, 새 토큰(B안) ──
        r = api('PATCH', '/auth/change-password', {'currentPassword': PW, 'newPassword': PW2}, role='customer', tokenVersion=1, **C)
        tok = (r.get('body') or {}).get('token')
        t.check('change-password 200 + 새 토큰', r.get('status') == 200 and bool(tok), 'status=%s' % r.get('status'))
        t.check('새 토큰 ver == 2', bool(tok) and _jwt_payload(tok).get('ver') == 2, 'ver=%s' % (_jwt_payload(tok).get('ver') if tok else None))
        r = dget('users', q, role='customer', tokenVersion=1, **C)
        t.check('변경 전 버전(1) → 401 (다른 기기·탈취분 폐기)', _bare401(r), 'status=%s' % r.get('status'))
        r = dget('users', q, role='customer', tokenVersion=2, **C)
        t.check('새 버전(2) → 200 (현재 세션 유지)', r.get('status') == 200, 'status=%s' % r.get('status'))

        # ── 로그아웃 → +1 ──
        r = api('POST', '/auth/logout', None, role='customer', tokenVersion=2, **C)
        t.check('logout 200', r.get('status') == 200, 'status=%s body=%s' % (r.get('status'), r.get('body')))
        r = dget('users', q, role='customer', tokenVersion=2, **C)
        t.check('로그아웃 후 옛 버전(2) → 401', _bare401(r), 'status=%s' % r.get('status'))
        r = dget('users', q, role='customer', tokenVersion=3, **C)
        t.check('로그아웃 후 다음 버전(3) → 200 (재로그인 시 받을 값)', r.get('status') == 200, 'status=%s' % r.get('status'))

        # ── 관리자 역할 변경 → +1 (data-api PATCH bump) ──
        r = dpatch('users', uid, {'role': 'customer'}, role='admin')
        t.check('admin role PATCH 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        r = dget('users', q, role='customer', tokenVersion=3, **C)
        t.check('역할 변경 후 옛 버전(3) → 401', _bare401(r), 'status=%s' % r.get('status'))
        r = dget('users', q, role='customer', tokenVersion=4, **C)
        t.check('역할 변경 후 새 버전(4) → 200', r.get('status') == 200, 'status=%s' % r.get('status'))

        # ── 프로필(name) 변경은 bump 없음 ──
        r = dpatch('users', uid, {'name': tname('토큰고객2')}, role='customer', tokenVersion=4, **C)
        t.check('name PATCH 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        r = dget('users', q, role='customer', tokenVersion=4, **C)
        t.check('name 변경은 버전 유지(4) → 200', r.get('status') == 200, 'status=%s' % r.get('status'))

        # ── 차단 컬럼 ──
        r = dget('users', {'select': 'id,token_version', 'id': 'eq.' + uid}, role='admin')
        row = (r.get('body') or [{}])[0] if isinstance(r.get('body'), list) else {}
        t.check('token_version 응답 차단(admin 조회에도 없음)', r.get('status') == 200 and 'token_version' not in row, 'row=%s' % row)
        r = dpatch('users', uid, {'token_version': 0}, role='admin')
        t.check('token_version 직접 쓰기 400', r.get('status') == 400, 'status=%s' % r.get('status'))
        r = dget('users', {'select': 'id', 'token_version': 'eq.4'}, role='admin')
        t.check('token_version 필터 400', r.get('status') == 400, 'status=%s' % r.get('status'))

        # ── 비활성화 → 어떤 버전이든 401 ──
        r = dpatch('users', uid, {'is_active': False}, role='admin')
        t.check('admin is_active=false 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        r = dget('users', q, role='customer', tokenVersion=5, **C)
        t.check('비활성화 계정 → 401 (버전 맞아도)', _bare401(r), 'status=%s' % r.get('status'))
    finally:
        if uid: ddel('users', uid, role='admin')
        if co_id: ddel('companies', co_id, role='admin')
    return t.report(min_checks=20)


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
