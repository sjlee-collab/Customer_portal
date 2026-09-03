"""L1 JWT 검증 테스트 — 인증 문지기(jwt-authorizer)를 실제 API Gateway 경유로 시험.

실행: python scripts/harness/tests/test_jwt.py
배경: 회귀는 Lambda 직접 invoke로 authorizer 컨텍스트를 주입하므로(원칙 3),
      문지기 자신(JWT 서명·만료·클레임 검증)은 구조적 사각지대였다(DESIGN §6.4).
      P4(테스트 계정 로그인을 통계·이력에서 제외 — LE_REAL)로 실로그인이 가능해져
      이 테스트가 열렸다. 유일하게 HTTP(API Gateway)를 실제로 타는 스위트.

검증:
  - 실로그인 → JWT 발급(header.payload.signature 형식)
  - 정상 토큰: API GW 경유 요청 200 + 클레임 전달 정확성(고객 토큰은 자기 회사
    티켓만 — companyId 클레임이 authorizer→data-api 스코프로 실제 흐름)
  - 무토큰 401 / 쓰레기·변조 토큰 403 — API GW 규약(신원없음 401, 무효 403)대로 거부
  - P4 검증: 이 실로그인이 로그인 이력(stats/login-history)에 안 보임(LE_REAL)
  ※ 만료 토큰은 런타임 제작 불가(JWT_SECRET 미보유) — authorizer의 exp 검사는
    코드 리뷰로 확인됨(jwt.mjs verifyToken). 서명 검증이 뚫리지 않는 한 만료 위조도 불가.

데이터: [테스트] 회사·고객·티켓(admin insert, 무알림) + 초기 비번은 change-password
초기설정 경로. 성공 로그인 1회의 login_events 행은 남지만 LE_REAL로 전 화면 제외(감사 보존).
"""
import sys, os, json, base64
import urllib.request, urllib.error
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, api, wipe_ticket, tname, temail, Checker

API_BASE = os.environ.get('API_BASE', 'https://8xbmazu4ij.execute-api.ap-northeast-2.amazonaws.com')


def http(method, path, body=None, token=None):
    """API Gateway를 실제 HTTPS로 호출 — authorizer를 통과시키는 유일한 경로."""
    req = urllib.request.Request(API_BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json',
                                          **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or 'null')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or 'null')
        except Exception: return e.code, None
    except Exception as e:
        return 0, {'error': str(e)}


def tamper(token, seg, pos=5):
    """토큰의 seg(1=payload, 2=signature)번째 조각 한 글자를 뒤집는다."""
    parts = token.split('.')
    s = parts[seg]
    ch = 'A' if s[pos] != 'A' else 'B'
    parts[seg] = s[:pos] + ch + s[pos + 1:]
    return '.'.join(parts)


def run():
    t = Checker('L1 JWT(authorizer 실경유)')
    created = {'companies': [], 'users': [], 'tickets': []}
    PW = 'JwtTest!234'
    try:
        co = dpost('companies', {'name': tname('JWT 회사'), 'status': 'active'})['body']['id']
        coX = dpost('companies', {'name': tname('JWT 타사'), 'status': 'active'})['body']['id']
        cu = dpost('users', {'email': temail('jwtCust'), 'name': tname('JWT고객'), 'role': 'customer',
                             'company_id': co, 'is_active': True})['body']['id']
        created['companies'] += [co, coX]; created['users'].append(cu)
        # 초기 비번 설정(미설정 계정 경로 — test_auth와 동일)
        r = api('PATCH', '/auth/change-password', {'newPassword': PW}, role='customer', userId=cu)
        t.check('픽스처: 초기 비번 설정', r.get('status') == 200, 'status=%s' % r.get('status'))
        # 클레임 스코프 검증용 티켓: 자기 회사 1 + 타사 1
        tin = dpost('tickets', {'title': tname('JWT 자사'), 'category': 'other', 'status': 'received',
                                'created_by': cu, 'company_id': co, 'company_name': tname('JWT 회사')},
                    role='admin')['body']['id']
        tout = dpost('tickets', {'title': tname('JWT 타사'), 'category': 'other', 'status': 'received',
                                 'created_by': cu, 'company_id': coX, 'company_name': tname('JWT 타사')},
                     role='admin')['body']['id']
        created['tickets'] += [tin, tout]

        # ── 실로그인(HTTP) → JWT 발급 ──
        code, body = http('POST', '/auth/login', {'email': temail('jwtCust'), 'password': PW})
        token = (body or {}).get('token') or ''
        t.check('실로그인 200 + 토큰 발급', code == 200 and token.count('.') == 2,
                'http=%s token형식=%s조각' % (code, token.count('.') + 1))

        # ── 정상 토큰: 문지기 통과 + 클레임이 실제로 스코프를 결정하나 ──
        code, rows = http('GET', '/data/tickets?select=id,company_id&limit=50', token=token)
        ids = [x.get('id') for x in (rows or [])]
        t.check('정상 토큰 200(문지기 통과)', code == 200, 'http=%s' % code)
        t.check('클레임 스코프: 자사 티켓 보임', tin in ids, '반환=%d건' % len(ids))
        t.check('클레임 스코프: 타사 티켓 안 보임', tout not in ids,
                'companyId 클레임이 data-api 격리로 흐름')

        # ── 문지기 거부 4종 ──
        code, _ = http('GET', '/data/tickets?limit=1')
        t.check('무토큰 401', code == 401, 'http=%s' % code)
        # API GW 규약: 토큰 없음=401(신원 없음), 있으나 무효=403(authorizer가 isAuthorized:false)
        code, _ = http('GET', '/data/tickets?limit=1', token='garbage.token.value')
        t.check('쓰레기 토큰 403', code == 403, 'http=%s' % code)
        code, _ = http('GET', '/data/tickets?limit=1', token=tamper(token, 2))
        t.check('서명 변조 403', code == 403, 'http=%s' % code)
        code, _ = http('GET', '/data/tickets?limit=1', token=tamper(token, 1))
        t.check('페이로드 변조 403(서명 불일치)', code == 403, 'http=%s' % code)

        # ── P4 검증: 이 실로그인이 로그인 이력에 안 보임(LE_REAL 제외) ──
        lh = api('GET', '/stats/login-history', None, role='admin', qs={'q': tname('JWT고객')}, userId='zz-admin')
        n = (lh.get('body') or {}).get('total', -1)
        t.check('로그인 이력에서 테스트 계정 제외(P4)', n == 0, 'total=%s' % n)
    finally:
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for x in created['users']: ddel('users', x, role='admin')
        for x in created['companies']: ddel('companies', x, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
