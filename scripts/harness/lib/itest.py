"""고객지원포탈 변경 하네스 — 공용 invoke 헬퍼 + 미니 테스트 러너.

Lambda(data-api / api-layer / public-inquiry / send-email / storage-api)를 직접 invoke 해서
백엔드 계약을 검증한다. API Gateway/JWT를 거치지 않고 authorizer.lambda 컨텍스트를 직접 주입하므로
로그인 없이 역할별 동작을 재현할 수 있다.

사용 전제: AWS CLI(aws.exe) + 프로파일 customer_portal, 리전 ap-northeast-2.
Windows/Git Bash 환경 기준(임시파일은 스레드 안전하게 고유 이름 사용).
"""
import os, json, subprocess, threading, time, contextlib

REGION = 'ap-northeast-2'
# 한 실행(프로세스)을 식별하는 토큰 — temail()에 섞어 테스트 계정 이메일을 실행마다 고유하게
# 만든다. users.email은 unique 제약이 있어, 예전엔 고정 주소(sjlee+permA@…)가 중단된 실행의
# 잔재 계정과 충돌해 재생성이 500(unique violation)→KeyError로 죽었다. pid+시각으로 충돌 제거.
# 한 프로세스 안에서는 값이 고정이라 "계정 생성 → 메일 트리거 → recipient로 로그 조회"가
# 같은 주소로 이어진다. +태그 뒤 무엇이 붙든 메일은 sjlee 싱크로 배달된다(plus-addressing).
_RUN = '%x%x' % (os.getpid(), int(time.time()) % 0x100000)
ENV = dict(os.environ); ENV['AWS_PROFILE'] = ENV.get('AWS_PROFILE', 'customer_portal')

# 소스 폴더명 ↔ 실제 배포 함수명 (CLAUDE.md 매핑)
FN = {
    'data':     'customer_portal_data-api',
    'api':      'customer-portal_slack_status_change',   # api-layer
    'inquiry':  'customer_portal_public-inquiry',
    'email':    'customer_portal_send-email',
    'storage':  'customer_portal_storage-api',
    'jwt':      'customer_portal_jwt-authorizer',        # 배포 스모크용(직접 invoke)
    'notify':   'customer_portal_notify-handler',        # 〃
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
    """테스트 계정 메일 — sink 주소의 +태그(+실행토큰). 예: temail('custA') ->
    sjlee+custA_<run>@bigxdata.io. 실행마다 고유해 잔재 계정과 충돌하지 않고, 전부 sjlee로 배달."""
    local, _, dom = TEST_EMAIL_BASE.partition('@')
    return '%s+%s_%s@%s' % (local, tag, _RUN, dom)


class HarnessError(RuntimeError):
    """하네스 자체의 실패(픽스처 생성 불가 등) — 제품 결함이 아니라 실행 환경 문제.

    예전엔 `dpost(...)['body']['id']` 가 실패 시 KeyError/TypeError로 죽어서, run()이
    report()에 닿지 못해 **결과 줄이 하나도 안 나오고** 이미 만든 운영 행도 남았다.
    응답 전문을 담은 이 예외로 바꿔 원인이 로그에 남게 한다."""


def must_id(resp, what='행'):
    """생성 응답에서 id를 꺼낸다 — 실패하면 응답 전문을 담아 HarnessError.
    `resp['body']['id']` 직접 접근을 대체한다(실패 시 중단이 아니라 진단 가능한 예외)."""
    body = resp.get('body') if isinstance(resp, dict) else None
    if isinstance(body, dict) and body.get('id'):
        return body['id']
    raise HarnessError('%s 생성 실패: status=%s invoke_err=%s body=%r' % (
        what, (resp or {}).get('status'), (resp or {}).get('_invoke_error'), body))


_TMPDIR = os.environ.get('HARNESS_TMP', os.path.dirname(os.path.abspath(__file__)))
_ctr = [0]

# ── 스키마 계약 파서 ──────────────────────────────────────────────────────
# schema.sql의 CHECK (col = any (array['a','b',...])) 제약에서 허용값 목록을 뽑는다.
# 테스트가 상태값·카테고리 등을 하드코딩하는 대신 스키마를 단일 출처로 삼아,
# 스키마가 바뀌면 계약 테스트가 자동으로 따라가거나 드리프트로 잡히게 한다(안 낡게).
_SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'backend', 'schema.sql')


def schema_values(table, col):
    """schema.sql에서 `create table public.<table>` 블록 안의 <col> CHECK 허용값 리스트.
    못 찾으면 None(파서 깨짐/제약 없음 — 호출부에서 실패로 처리)."""
    import re
    try:
        txt = open(_SCHEMA_PATH, encoding='utf-8').read()
    except OSError:
        return None
    mt = re.search(r'create table public\.%s\s*\((.*?)\n\);' % re.escape(table), txt, re.S | re.I)
    block = mt.group(1) if mt else txt
    mc = re.search(r'\bcheck\s*\(\s*%s\s*=\s*any\s*\(\s*array\[(.*?)\]' % re.escape(col), block, re.S | re.I)
    if not mc:
        return None
    return [v for v in re.findall(r"'([^']*)'", mc.group(1))]

# boto3 클라이언트 캐시 — CLI subprocess는 호출당 ~1초(aws.exe 기동)를 쓰는데 테스트
# 1회 전체가 수백 번 invoke하므로 이게 회귀 소요시간의 큰 몫이었다. boto3가 있으면
# 단일 세션을 재사용하고(임시파일도 불필요), 없으면 기존 CLI 경로로 폴백한다.
_boto = {'client': None, 'tried': False, 'lock': threading.Lock()}


def _lambda_client():
    with _boto['lock']:
        if not _boto['tried']:
            _boto['tried'] = True
            try:
                import boto3
                _boto['client'] = boto3.session.Session(
                    profile_name=ENV.get('AWS_PROFILE', 'customer_portal'),
                    region_name=REGION).client('lambda')
            except Exception:
                _boto['client'] = None  # boto3 미설치/프로파일 문제 → CLI 폴백
    return _boto['client']


def _parse(raw):
    if isinstance(raw, dict) and 'statusCode' in raw:
        body = raw.get('body')
        try:
            body = json.loads(body) if isinstance(body, str) else body
        except Exception:
            pass
        return {'status': raw['statusCode'], 'body': body}
    return {'raw': raw}


def invoke(fn, event):
    """fn: FN 키('data'|'api'|...). event: Lambda 이벤트(dict). 응답을 파싱해 반환."""
    client = _lambda_client()
    if client is not None:
        try:
            res = client.invoke(FunctionName=FN[fn],
                                Payload=json.dumps(event, ensure_ascii=False).encode('utf-8'))
            raw = json.loads(res['Payload'].read().decode('utf-8'))
        except Exception as e:
            return {'_invoke_error': str(e)}
        return _parse(raw)

    # ── CLI 폴백 (boto3 없는 환경) ──
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
    return _parse(raw)


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


def api(method, path, body=None, role='customer', qs=None, **c):
    e = ctx(role, **c); e['requestContext']['http']['method'] = method
    # 쿼리스트링은 rawPath에 붙이면 안 된다 — api-layer 라우팅이 path 정확 일치라 404가 난다.
    e['rawPath'] = path
    if qs: e['queryStringParameters'] = qs
    if body is not None:
        e['body'] = json.dumps(body, ensure_ascii=False)
    return invoke('api', e)


def batch(task, only_test=True, **extra):
    """EventBridge 배치를 직접 invoke 한다 — {task, ...}. api-layer는 event.task로 분기하며
    HTTP(requestContext) 없이 이 경로에 든다.

    only_test는 **기본이 True**다. 예전엔 기본값이 없어서 호출자가 빠뜨리면 운영 전체를
    스캔·발송·변경했고(만료 계약 일괄 UPDATE + 실 채널 팬아웃), 그걸 막는 장치가 독스트링
    경고뿐이었다. 잊었을 때의 기본값이 안전해야 한다는 설계 원칙(DESIGN §2-1)에 맞춰
    시그니처가 막게 바꿨다. 운영 전체 스캔이 정말 필요하면 only_test=False를 명시할 것."""
    return invoke('api', dict(task=task, only_test=only_test, **extra))


@contextlib.contextmanager
def permission(role, feature_key, enabled):
    """role_permissions 토글을 **진입 시점의 실제 값**으로 되돌리는 컨텍스트 매니저.

    ⚠️ 이 백엔드는 운영과 공유된다. 예전엔 각 테스트가 finally에서 하드코딩된 값으로
    되돌렸다 — test_stats_view는 조회해둔 값을 버리고 늘 False로, test_ticket_delete는
    원래 값을 조회조차 않고 늘 True로. 그래서 관리자가 권한 관리 화면에서 바꿔둔 설정을
    회귀가 돌 때마다 조용히 덮어쓰고 '✅ 전체 PASS'를 찍었다.
    여기서는 진입 값을 캡처해 그 값으로만 복원하고, 바꿀 필요가 없으면 아예 쓰지 않는다.

    사용: with permission('sales', 'stats_view', False): ...  # 블록 끝나면 원래대로"""
    rows = dget('role_permissions',
                {'select': 'id,enabled', 'role': 'eq.' + role, 'feature_key': 'eq.' + feature_key},
                role='admin').get('body') or []
    if not rows:
        raise HarnessError('role_permissions 시드행 없음: %s/%s' % (role, feature_key))
    rid, orig = rows[0]['id'], rows[0].get('enabled')
    changed = bool(orig) != bool(enabled)
    if changed:
        dpatch('role_permissions', rid, {'enabled': bool(enabled)}, role='admin')
    try:
        yield rid
    finally:
        if changed:   # 캡처한 원래 값으로만 복원 — 기본값 추정 금지
            dpatch('role_permissions', rid, {'enabled': orig}, role='admin')


def notif_rows(ticket_id, channel=None):
    """티켓의 알림 발송 로그(log_notification) 조회 — 슬랙/메일 발송 여부 판정용.
    발송은 deferNotify(비동기 Event invoke)라 응답으로 볼 수 없고 이 로그가 유일한 관찰 지점.
    웹훅 미설정 환경에서도 status='failure' 행은 남으므로 '라우팅 결정' 자체는 검증된다."""
    rows = dget('log_notification',
                {'select': 'channel,event_type,recipient,status,error_message,content',
                 'ticket_id': 'eq.' + ticket_id, 'limit': '200'}, role='admin').get('body') or []
    return [r for r in rows if channel is None or r.get('channel') == channel]


def wait_notif(ticket_id, channel, expect_n, settle_sec=30, grace_sec=4):
    """비동기 알림이 expect_n건 로그에 찰 때까지 대기 후, '더 오면 안 되는' 초과 발송을
    잡기 위해 grace만큼 더 기다렸다가 전체 행을 반환한다."""
    import time
    deadline = time.time() + settle_sec
    while time.time() < deadline:
        if len(notif_rows(ticket_id, channel)) >= expect_n:
            break
        time.sleep(2)
    time.sleep(grace_sec)
    return notif_rows(ticket_id, channel)


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


# 픽스처 종류 ↔ 실제 테이블. 정리는 ORDER 순서(자식→부모)로 돈다.
_FIX_TABLE = {
    'tickets': 'tickets', 'documents': 'content_documents', 'licenses': 'company_licenses',
    'users': 'users', 'contracts': 'company_contracts', 'companies': 'companies',
}


class Fixtures:
    """픽스처 **생성과 정리 등록을 원자적으로** 묶는 팩토리.

    왜: 기존 패턴은 여러 행을 만든 뒤 한꺼번에 등록했다 —
        co = dpost('companies', ...)['body']['id']
        cu = dpost('users', ...)['body']['id']
        created['companies'].append(co); created['users'].append(cu)   # ← 여기서야 등록
    중간 dpost가 실패하면 KeyError로 죽고, finally는 빈 created를 보고 아무것도 안 지운다.
    이미 만들어진 회사·유저는 운영 DB에 그대로 남는다. 이 클래스는 만든 즉시 등록하므로
    어느 시점에 죽어도 cleanup()이 전부 회수한다.

    사용:
        fx = Fixtures()
        try:
            co = fx.company('회사A')
            cu = fx.user('고객A', 'custA', 'customer', company_id=co)
        finally:
            for kind, rid, why in fx.cleanup():
                print('정리 실패:', kind, rid, why)
    """
    ORDER = ['tickets', 'documents', 'licenses', 'users', 'contracts', 'companies']

    def __init__(self):
        self.reg = {k: [] for k in self.ORDER}

    def track(self, kind, rid):
        """다른 경로(실 api-layer 등)로 만든 행을 정리 대상에 편입 — 점진 이행용."""
        if kind not in self.reg:
            raise HarnessError('알 수 없는 픽스처 종류: %s' % kind)
        if rid:
            self.reg[kind].append(rid)
        return rid

    def _mk(self, kind, obj, what):
        return self.track(kind, must_id(dpost(_FIX_TABLE[kind], obj, role='admin'), what))

    def company(self, suffix='회사', **extra):
        return self._mk('companies', dict({'name': tname(suffix)}, **extra), '회사')

    def user(self, suffix, tag, role, company_id=None, **extra):
        obj = {'name': tname(suffix), 'email': temail(tag), 'role': role}
        if company_id:
            obj['company_id'] = company_id
        return self._mk('users', dict(obj, **extra), '사용자')

    def ticket(self, suffix='요청', **extra):
        return self._mk('tickets', dict({'title': tname(suffix)}, **extra), '요청')

    def document(self, suffix='자료', **extra):
        return self._mk('documents', dict({'title': tname(suffix)}, **extra), '자료')

    def contract(self, suffix='계약', **extra):
        return self._mk('contracts', dict({'contract_name': tname(suffix)}, **extra), '계약')

    def license(self, **extra):
        return self._mk('licenses', dict(extra), '라이선스')

    def cleanup(self):
        """등록 역순으로 정리하고 **실패 목록을 반환**한다.

        ddel은 예외를 던지지 않고 오류를 dict로 돌려주므로, 예전엔 반환값을 버리는 바람에
        403/FK 위반으로 정리가 실패해도 아무도 몰랐다(스위트는 그대로 PASS).
        호출부가 이 반환값을 확인하면 정리 실패가 보인다."""
        failed = []
        for kind in self.ORDER:
            for rid in reversed(self.reg[kind]):
                try:
                    if kind == 'tickets':
                        wipe_ticket(rid)
                        continue
                    if kind in ('companies', 'contracts'):   # 참조 자식 먼저(FK)
                        _purge_children_by('company_id' if kind == 'companies' else 'contract_id', rid)
                    r = ddel(_FIX_TABLE[kind], rid, role='admin')
                    if r.get('status') not in (200, 204, 404):
                        failed.append((kind, rid, 'status=%s' % r.get('status')))
                except Exception as e:                        # noqa: BLE001 — 정리는 끝까지 돈다
                    failed.append((kind, rid, str(e)))
            self.reg[kind] = []
        return failed


class Checker:
    """미니 테스트 러너 — check()로 단언, report()로 요약."""
    def __init__(self, title=''):
        self.title = title
        self.results = []

    def check(self, name, cond, detail=''):
        self.results.append((name, bool(cond), detail))
        return bool(cond)

    def all_of(self, name, rows, pred, min_n=1, detail=None):
        """**비어 있으면 실패하는** all(). 파이썬 all()은 빈 리스트에서 공허하게 참이라,
        조회가 오류(=invoke가 빈 목록 반환)로 비면 격리·권한 단언이 통과해 버렸다.
        '기능을 통째로 지워도 PASS'가 되던 거짓통과의 주범 — min_n건 이상 있고 전부
        pred를 만족해야 통과한다."""
        rows = list(rows or [])
        if len(rows) < min_n:
            return self.check(name, False, detail or
                              ('대상 %d건 — 최소 %d건 필요(빈 목록에 공허한 단언 방지)' % (len(rows), min_n)))
        bad = [x for x in rows if not pred(x)]
        return self.check(name, not bad, detail or
                          ('%d/%d건 위반%s' % (len(bad), len(rows), (': %r' % (bad[:3],)) if bad else '')))

    def report(self, min_checks=1):
        """min_checks: 이 스위트가 최소 몇 건을 실행해야 하는지. 예전엔 검사 0건이면
        `0 == 0`으로 **통과**여서, 러너가 조용히 skip되거나 픽스처가 죽어 아무 검사도
        못 돈 스위트가 초록으로 보고됐다. 기본값 1이라 0/0은 이제 항상 실패한다."""
        import sys
        try: sys.stdout.reconfigure(encoding='utf-8')
        except Exception: pass
        p = sum(1 for _, c, _ in self.results if c)
        n = len(self.results)
        if self.title:
            print('\n=== %s ===' % self.title)
        for name, c, d in self.results:
            print('%-4s %s%s' % ('PASS' if c else 'FAIL', name, ('  (%s)' % d) if d else ''))
        short = n < min_checks
        if short:
            print('FAIL 검사 수 부족 — %d건 실행(최소 %d건). 스위트가 실제로 돌지 않았다.' % (n, min_checks))
        # 이 줄의 형식('N/M PASS')은 regression-nightly.sh 요약 파서가 읽는다 — 바꾸지 말 것.
        print('%d/%d PASS' % (p, n))
        return (p == n) and not short
