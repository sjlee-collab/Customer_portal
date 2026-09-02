"""L1 스키마 계약 테스트 — CHECK 제약을 단일 출처로, 값이 늘어도 안 낡게.

실행: python scripts/harness/tests/test_schema_contract.py
배경: 상태값·카테고리 같은 enum 기대값이 각 테스트에 하드코딩돼, 스키마가 바뀌면
      조용히 낡는다. 이 테스트는 schema.sql의 CHECK 제약을 파싱해 두 가지를 고정한다.

축 1 — 스키마 ↔ 라이브 DB 일치:
  schema.sql이 선언한 허용값을 실제로 admin insert 해서 전부 통과하는지,
  스키마에 없는 값은 거부되는지 확인. schema.sql이 배포된 DB 제약과 어긋나면(드리프트)
  여기서 잡힌다(Lambda drift와 같은 부류를 데이터 계층에서 감지).

축 2 — 스키마 ↔ 테스트 커버리지:
  test_ticket_status가 도는 상태 목록이 schema(tickets.status)에서 초기값(received)만
  뺀 집합과 정확히 일치하는지. 스키마에 상태가 추가됐는데 테스트가 안 따라오면 실패 →
  "새 값이 생겼으니 테스트를 늘려라"고 알린다.

데이터: [테스트] 라벨 회사·유저·티켓을 admin 직접 insert(알림 없음), 종료 시 정리.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, wipe_ticket, schema_values, tname, temail, Checker

BOGUS = '__bogus_value__'


def run():
    t = Checker('L1 스키마 계약(CHECK 단일 출처)')
    created = {'companies': [], 'users': [], 'tickets': []}
    try:
        # 공용 픽스처 (티켓 insert에 필요한 회사·유저)
        co = dpost('companies', {'name': tname('계약 회사'), 'status': 'active'})['body']['id']
        u = dpost('users', {'email': temail('schemaT'), 'name': tname('계약고객'), 'role': 'customer',
                            'company_id': co, 'is_active': True})['body']['id']
        created['companies'].append(co); created['users'].append(u)

        def has_id(r):
            b = r.get('body') if isinstance(r, dict) else None
            b = b[0] if isinstance(b, list) and b else b
            return isinstance(b, dict) and bool(b.get('id')), (b or {}).get('id') if isinstance(b, dict) else None

        def mk_ticket(**over):
            base = {'title': tname('계약'), 'category': 'other', 'status': 'received',
                    'created_by': u, 'company_id': co, 'company_name': tname('계약 회사')}
            base.update(over)
            r = dpost('tickets', base, role='admin')
            ok, tid = has_id(r)
            if tid: created['tickets'].append(tid)
            return ok, r

        # ── 축 1: tickets.status / category / priority — 허용값 전부 통과, 불량값 거부 ──
        for col in ('status', 'category', 'priority'):
            vals = schema_values('tickets', col)
            t.check('schema tickets.%s 파싱됨' % col, bool(vals), '값=%s' % vals)
            for v in (vals or []):
                ok, r = mk_ticket(**{col: v})
                t.check('tickets.%s=%s 허용' % (col, v), ok, 'status=%s' % r.get('status'))
            ok, r = mk_ticket(**{col: BOGUS})
            t.check('tickets.%s=불량값 거부' % col, not ok, 'status=%s' % r.get('status'))

        # ── 축 1: companies.status — 허용값 통과, 불량값 거부 ──
        cvals = schema_values('companies', 'status')
        t.check('schema companies.status 파싱됨', bool(cvals), '값=%s' % cvals)
        for v in (cvals or []):
            r = dpost('companies', {'name': tname('계약 회사 ' + v), 'status': v}, role='admin')
            ok, cid = has_id(r)
            if cid: created['companies'].append(cid)
            t.check('companies.status=%s 허용' % v, ok, 'status=%s' % r.get('status'))
        rb = dpost('companies', {'name': tname('계약 불량'), 'status': BOGUS}, role='admin')
        okb, cidb = has_id(rb)
        if cidb: created['companies'].append(cidb)
        t.check('companies.status=불량값 거부', not okb, 'status=%s' % rb.get('status'))

        # ── 축 2: 스키마 ↔ test_ticket_status 커버리지 ──
        # test_ticket_status.STATUSES == schema(tickets.status) - {최초값 received}
        try:
            import test_ticket_status as tts
            covered = set(tts.STATUSES)
        except Exception as e:
            covered = None
            t.check('test_ticket_status.STATUSES 임포트', False, str(e))
        if covered is not None:
            schema_status = set(schema_values('tickets', 'status') or [])
            expected = schema_status - {'received'}   # received는 생성 시점 초기값이라 전이 대상 아님
            missing = expected - covered   # 스키마엔 있는데 상태 테스트가 안 도는 값
            extra = covered - expected     # 테스트엔 있는데 스키마에 없는 값(오타·삭제된 값)
            t.check('상태 커버리지 = 스키마(−received)', covered == expected,
                    '누락(테스트 필요)=%s / 잉여(스키마에 없음)=%s' % (sorted(missing), sorted(extra)))
    finally:
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for x in created['users']: ddel('users', x, role='admin')
        for x in created['companies']: ddel('companies', x, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
