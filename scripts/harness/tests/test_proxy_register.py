"""L1 백엔드 계약 테스트 — 대리 등록(내부 계정이 고객 대신 요청 접수).

실행: python scripts/harness/tests/test_proxy_register.py
검증:
  - /proxy/bootstrap·/proxy/customers : internal 200 / 고객 403 (internal 전용 게이팅)
  - createTicket 대리 분기 : internal이 on_behalf_of 고객으로 접수 → created_by=고객,
    registered_by=내부직원(스냅샷), 담당자=선택 스태프, 회사=고객 회사
  - 신뢰경계 : 고객(customer)이 on_behalf_of를 줘도 무시(created_by=본인, registered_by=null)
모든 데이터는 '[테스트]' 라벨. 메일은 email-safe on 상태에서 실행할 것(대리 건은 코드가 고객 메일을 skip).
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import api, dget, dpost, dpatch, ddel, ctx, invoke, wipe_ticket, tname, temail, Checker


def api_get_qs(path, qs, role, **c):
    e = ctx(role, **c); e['requestContext']['http']['method'] = 'GET'
    e['rawPath'] = path; e['queryStringParameters'] = qs
    return invoke('api', e)


def run():
    t = Checker('L1 대리 등록(proxy register)')
    co_id = cust_id = int_id = None
    tickets = []
    perm_row = None; perm_orig = None
    try:
        # ── 테스트 데이터 준비 ──
        co = dpost('companies', {'name': tname('대리회사')}, role='admin').get('body')
        co_id = (co[0] if isinstance(co, list) else co or {}).get('id')
        t.check('테스트 고객사 생성', bool(co_id), 'co=%s' % co)

        cust = dpost('users', {'name': tname('대리고객'), 'email': temail('proxycust'),
                               'role': 'customer', 'company_id': co_id, 'is_active': True}, role='admin').get('body')
        cust_id = (cust[0] if isinstance(cust, list) else cust or {}).get('id')
        t.check('테스트 고객(요청자) 생성', bool(cust_id))

        intu = dpost('users', {'name': tname('대리내부'), 'email': temail('proxyint'),
                               'role': 'internal', 'is_active': True}, role='admin').get('body')
        int_id = (intu[0] if isinstance(intu, list) else intu or {}).get('id')
        t.check('테스트 내부직원 생성', bool(int_id))

        # internal의 ticket_create 권한 보장(없으면 대리 등록 403)
        rows = dget('role_permissions', {'select': 'id,enabled', 'role': 'eq.internal', 'feature_key': 'eq.ticket_create'}, role='admin').get('body') or []
        perm_row = rows[0] if rows else None
        if perm_row:
            perm_orig = perm_row.get('enabled')
            if not perm_orig:
                dpatch('role_permissions', perm_row['id'], {'enabled': True}, role='admin')

        # ── 조회 엔드포인트 게이팅 ──
        rb = api_get_qs('/proxy/bootstrap', {}, role='internal', userId=int_id)
        bb = rb.get('body') or {}
        t.check('bootstrap internal 200', rb.get('status') == 200, 'status=%s' % rb.get('status'))
        t.check('bootstrap 구조(companies/staff)', isinstance(bb.get('companies'), list) and isinstance(bb.get('staff'), list))
        staff = bb.get('staff') or []
        staff_id = staff[0]['id'] if staff else None
        t.check('스태프 목록 비어있지 않음', bool(staff_id), 'staff=%d' % len(staff))

        rbc = api_get_qs('/proxy/bootstrap', {}, role='customer', userId=cust_id, companyId=co_id)
        t.check('bootstrap 고객 차단 403', rbc.get('status') == 403, 'status=%s' % rbc.get('status'))

        rcu = api_get_qs('/proxy/customers', {'company_id': co_id}, role='internal', userId=int_id)
        cb = rcu.get('body') or {}
        got_cust = [u for u in (cb.get('customers') or []) if u.get('id') == cust_id]
        t.check('customers internal 200', rcu.get('status') == 200, 'status=%s' % rcu.get('status'))
        t.check('선택 고객사의 고객 목록에 테스트 고객 포함', bool(got_cust))

        # ── 대리 등록(핵심) ──
        r = api('POST', '/tickets', {'title': tname('대리요청'), 'category': 'customer',
                                     'description': 'proxy test', 'on_behalf_of': cust_id,
                                     'assigned_to': staff_id}, role='internal', userId=int_id)
        tk = (r.get('body') or {}).get('ticket') or {}
        if tk.get('id'): tickets.append(tk['id'])
        t.check('대리 등록 201', r.get('status') == 201, 'status=%s body=%s' % (r.get('status'), r.get('body')))
        t.check('created_by = 고객(요청 명의)', tk.get('created_by') == cust_id, 'created_by=%s' % tk.get('created_by'))
        t.check('registered_by = 내부직원(대리자)', tk.get('registered_by') == int_id, 'registered_by=%s' % tk.get('registered_by'))
        t.check('registered_by_name 스냅샷 기록', bool(tk.get('registered_by_name')))
        t.check('company_id = 고객 회사', tk.get('company_id') == co_id, 'company_id=%s' % tk.get('company_id'))
        t.check('담당자 = 선택 스태프', tk.get('assigned_to') == staff_id, 'assigned_to=%s' % tk.get('assigned_to'))

        # ── 신뢰경계: 고객이 on_behalf_of를 줘도 무시(사칭 방지) ──
        r2 = api('POST', '/tickets', {'title': tname('비대리요청'), 'category': 'customer',
                                      'description': 'boundary test', 'on_behalf_of': int_id},
                 role='customer', userId=cust_id, companyId=co_id)
        tk2 = (r2.get('body') or {}).get('ticket') or {}
        if tk2.get('id'): tickets.append(tk2['id'])
        t.check('고객 등록 201', r2.get('status') == 201, 'status=%s' % r2.get('status'))
        t.check('고객 등록은 created_by=본인(on_behalf_of 무시)', tk2.get('created_by') == cust_id, 'created_by=%s' % tk2.get('created_by'))
        t.check('고객 등록은 registered_by 없음(직접 등록)', not tk2.get('registered_by'), 'registered_by=%s' % tk2.get('registered_by'))
    finally:
        for tid in tickets: wipe_ticket(tid)
        if cust_id: ddel('users', cust_id, role='admin')
        if int_id: ddel('users', int_id, role='admin')
        if co_id: ddel('companies', co_id, role='admin')
        if perm_row and perm_orig is False:  # 켰던 경우만 원복
            dpatch('role_permissions', perm_row['id'], {'enabled': False}, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
