"""고객지원포탈 변경 하네스 — 공용 invoke 헬퍼 + 미니 테스트 러너.

Lambda(data-api / api-layer / public-inquiry / send-email / storage-api)를 직접 invoke 해서
백엔드 계약을 검증한다. API Gateway/JWT를 거치지 않고 authorizer.lambda 컨텍스트를 직접 주입하므로
로그인 없이 역할별 동작을 재현할 수 있다.

사용 전제: AWS CLI(aws.exe) + 프로파일 customer_portal, 리전 ap-northeast-2.
Windows/Git Bash 환경 기준(임시파일은 스레드 안전하게 고유 이름 사용).
"""
import os, json, subprocess, threading

REGION = 'ap-northeast-2'
ENV = dict(os.environ); ENV['AWS_PROFILE'] = ENV.get('AWS_PROFILE', 'customer_portal')

# 소스 폴더명 ↔ 실제 배포 함수명 (CLAUDE.md 매핑)
FN = {
    'data':     'customer_portal_data-api',
    'api':      'customer-portal_slack_status_change',   # api-layer
    'inquiry':  'customer_portal_public-inquiry',
    'email':    'customer_portal_send-email',
    'storage':  'customer_portal_storage-api',
}

# ── 테스트 데이터 식별 규칙 ───────────────────────────────────────────────
# 하네스가 만드는 모든 데이터는 사람이 바로 알아볼 수 있도록 이름/제목 필드에
# 반드시 이 문자열을 붙인다(운영 데이터에 섞여도 '테스트'임이 한눈에 보이게).
# 이 라벨은 정리(sweep)용 검색 토큰이기도 하다.
TEST_PREFIX = '[테스트]'
# 테스트 계정 메일은 항상 이 sink(+태그) 주소만 사용한다(실 고객에게 발송 방지).
TEST_EMAIL_BASE = 'sjlee@bigxdata.io'


def tname(suffix=''):
    """테스트용 이름/제목 생성 — 항상 '[테스트]' 접두. 예: tname('회사A') -> '[테스트] 회사A'."""
    s = str(suffix).strip()
    return (TEST_PREFIX + ' ' + s) if s else TEST_PREFIX


def temail(tag):
    """테스트 계정 메일 생성 — sink 주소의 +태그. 예: temail('custA') -> sjlee+custA@bigxdata.io."""
    local, _, dom = TEST_EMAIL_BASE.partition('@')
    return '%s+%s@%s' % (local, tag, dom)


_TMPDIR = os.environ.get('HARNESS_TMP', os.path.dirname(os.path.abspath(__file__)))
_ctr = [0]


def invoke(fn, event):
    """fn: FN 키('data'|'api'|...). event: Lambda 이벤트(dict). 응답을 파싱해 반환."""
    _ctr[0] += 1
    tag = '%d_%d' % (threading.get_ident(), _ctr[0])
    pf = os.path.join(_TMPDIR, '_payload_%s.json' % tag)
    of = os.path.join(_TMPDIR, '_out_%s.json' % tag)
    with open(pf, 'w', encoding='utf-8') as f:
        json.dump(event, f, ensure_ascii=False)
    r = subprocess.run(
        ['aws', 'lambda', 'invoke', '--function-name', FN[fn], '--region', REGION,
         '--cli-binary-format', 'raw-in-base64-out', '--payload', 'fileb://' + pf, of],
        capture_output=True, text=True, env=ENV)
    try:
        with open(of, encoding='utf-8') as f:
            raw = json.load(f)
    except Exception as e:
        return {'_invoke_error': str(e), '_stderr': r.stderr[:300]}
    finally:
        for p in (pf, of):
            try: os.remove(p)
            except OSError: pass
    if isinstance(raw, dict) and 'statusCode' in raw:
        body = raw.get('body')
        try:
            body = json.loads(body) if isinstance(body, str) else body
        except Exception:
            pass
        return {'status': raw['statusCode'], 'body': body}
    return {'raw': raw}


def ctx(role, userId=None, companyId=None, contractId=None, unitIds=None):
    lam = {'role': role}
    if userId: lam['userId'] = userId
    if companyId: lam['companyId'] = companyId
    if contractId: lam['contractId'] = contractId
    if unitIds: lam['unitIds'] = ','.join(unitIds)
    return {'requestContext': {'authorizer': {'lambda': lam}, 'http': {'method': None}}}


def dget(table, qs, role='admin', **c):
    e = ctx(role, **c); e['requestContext']['http']['method'] = 'GET'
    e['rawPath'] = '/data/' + table; e['queryStringParameters'] = qs
    return invoke('data', e)


def dpost(table, obj, role='admin', **c):
    e = ctx(role, **c); e['requestContext']['http']['method'] = 'POST'
    e['rawPath'] = '/data/' + table; e['body'] = json.dumps(obj, ensure_ascii=False)
    return invoke('data', e)


def dpatch(table, _id, obj, role='admin', **c):
    e = ctx(role, **c); e['requestContext']['http']['method'] = 'PATCH'
    e['rawPath'] = '/data/%s/%s' % (table, _id); e['body'] = json.dumps(obj, ensure_ascii=False)
    return invoke('data', e)


def ddel(table, _id, role='admin', **c):
    e = ctx(role, **c); e['requestContext']['http']['method'] = 'DELETE'
    e['rawPath'] = '/data/%s/%s' % (table, _id)
    return invoke('data', e)


def api(method, path, body=None, role='customer', **c):
    e = ctx(role, **c); e['requestContext']['http']['method'] = method
    e['rawPath'] = path
    if body is not None:
        e['body'] = json.dumps(body, ensure_ascii=False)
    return invoke('api', e)


def wipe_ticket(ticket_id):
    """티켓 + 자식행(이력·답글·메모·첨부·알림로그)을 admin으로 완전 삭제(테스트 정리용)."""
    for tbl in ['ticket_history', 'ticket_replies', 'ticket_memos', 'ticket_attachments', 'log_notification']:
        for r in (dget(tbl, {'select': 'id', 'ticket_id': 'eq.' + ticket_id, 'limit': '200'}, role='admin').get('body') or []):
            ddel(tbl, r['id'], role='admin')
    ddel('tickets', ticket_id, role='admin')


# 라벨 기반 정리 대상: (테이블, 라벨이 실리는 컬럼) — FK 안전 순서(자식→부모)로 나열.
# users.contract_id/company_id, contracts/licenses.company_id 등을 고려해
# tickets → docs → users → contracts → companies 순으로 지운다.
_SWEEP_TABLES = [
    ('tickets', 'title'),
    ('content_documents', 'title'),
    ('users', 'name'),
    ('company_contracts', 'contract_name'),
    ('companies', 'name'),
]


def find_test_rows():
    """이름/제목에 '[테스트]' 라벨이 붙은 잔여 행을 테이블별로 조회(정리 전 미리보기)."""
    out = {}
    for tbl, col in _SWEEP_TABLES:
        # data-api는 ilike + SQL LIKE 와일드카드('%')만 지원. '[테스트]'로 시작하는 행만.
        rows = dget(tbl, {'select': 'id,' + col, col: 'ilike.' + TEST_PREFIX + '%', 'limit': '500'}, role='admin').get('body')
        if isinstance(rows, list) and rows:
            out[tbl] = [(r['id'], r.get(col, '')) for r in rows]
    return out


def _purge_children_by(col, val):
    """부모(회사/계약) 삭제 전, 이를 참조하는 자식행 제거(라벨 없는 자식도 부모 라벨로 안전 삭제)."""
    for tbl in ['company_licenses', 'company_contracts', 'users']:
        if tbl == 'company_contracts' and col == 'contract_id':
            continue
        for r in (dget(tbl, {'select': 'id', col: 'eq.' + val, 'limit': '500'}, role='admin').get('body') or []):
            ddel(tbl, r['id'], role='admin')


def sweep_test_data(dry_run=True):
    """'[테스트]' 라벨이 붙은 잔여 데이터를 정리한다(중단된 실행 뒷정리용).
    dry_run=True면 삭제 없이 대상만 반환. 티켓은 자식행까지 wipe_ticket으로 삭제.
    회사/계약은 참조 자식(라이선스·계약·유저)을 먼저 제거해 FK 위반 없이 삭제한다.
    라벨로만 대상을 고르므로 라벨 없는 운영 데이터는 절대 건드리지 않는다."""
    found = find_test_rows()
    if not dry_run:
        for tid, _ in found.get('tickets', []):
            wipe_ticket(tid)
        for rid, _ in found.get('content_documents', []):
            ddel('content_documents', rid, role='admin')
        for rid, _ in found.get('users', []):
            ddel('users', rid, role='admin')
        for rid, _ in found.get('company_contracts', []):
            _purge_children_by('contract_id', rid)   # 이 계약의 라이선스/유저 먼저
            ddel('company_contracts', rid, role='admin')
        for rid, _ in found.get('companies', []):
            _purge_children_by('company_id', rid)     # 이 회사의 라이선스/계약/유저 먼저
            ddel('companies', rid, role='admin')
    return found


class Checker:
    """미니 테스트 러너 — check()로 단언, report()로 요약."""
    def __init__(self, title=''):
        self.title = title
        self.results = []

    def check(self, name, cond, detail=''):
        self.results.append((name, bool(cond), detail))
        return bool(cond)

    def report(self):
        import sys
        try: sys.stdout.reconfigure(encoding='utf-8')
        except Exception: pass
        p = sum(1 for _, c, _ in self.results if c)
        n = len(self.results)
        if self.title:
            print('\n=== %s ===' % self.title)
        for name, c, d in self.results:
            print('%-4s %s%s' % ('PASS' if c else 'FAIL', name, ('  (%s)' % d) if d else ''))
        print('%d/%d PASS' % (p, n))
        return p == n
