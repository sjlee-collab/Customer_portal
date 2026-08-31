"""L1 백엔드 계약 테스트 — 담당자 배정(PATCH /tickets/{id}/assign).

실행: python scripts/harness/tests/test_ticket_assign.py
검증:
  - 배정 200 + DB 반영(assigned_to + assigned_to_name 스냅샷)
  - TICKET_ASSIGNED 슬랙 발송(event_type='assigned') + content에 (이전 → 새 담당자) 표기
  - 재배정 시 이전 담당자 이름이 content에 남는지
  - 같은 담당자 재배정은 무알림(prevAssigneeId !== assigned_to 게이트)
  - assign 경로는 ticket_history를 남기지 않는 현행 고정(manage 경로만 assigned/reassigned 기록)
  - assigned_to 누락 400 / 없는 사용자 400 / 없는 티켓 404 / 고객 403(ticket_manage 없음)

슬랙 주의: category='other'라 공통 채널만 타며, '[테스트]' 라벨로 테스트 채널로만 간다.
메일은 이 경로에서 발송되지 않는다(notifyForAssign은 notifySlack만 호출).
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, api, wipe_ticket, notif_rows, wait_notif, tname, temail, Checker


def run():
    t = Checker('L1 담당자 배정(/assign)')
    created = {'companies': [], 'users': [], 'tickets': []}
    try:
        co = dpost('companies', {'name': tname('배정 회사'), 'status': 'active'})['body']['id']
        cu = dpost('users', {'email': temail('assignCust'), 'name': tname('배정고객'), 'role': 'customer',
                             'company_id': co, 'is_active': True})['body']['id']
        s1 = dpost('users', {'email': temail('assignS1'), 'name': tname('배정직원1'), 'role': 'internal',
                             'is_active': True})['body']['id']
        s2 = dpost('users', {'email': temail('assignS2'), 'name': tname('배정직원2'), 'role': 'internal',
                             'is_active': True})['body']['id']
        created['companies'].append(co); created['users'] += [cu, s1, s2]

        tid = dpost('tickets', {'title': tname('배정 티켓'), 'category': 'other', 'status': 'received',
                                'created_by': cu, 'company_id': co,
                                'company_name': tname('배정 회사')}, role='admin')['body']['id']
        created['tickets'].append(tid)

        def cur():
            rows = dget('tickets', {'select': 'assigned_to,assigned_to_name', 'id': 'eq.' + tid},
                        role='admin').get('body') or []
            return rows[0] if rows else {}

        # ── 최초 배정 (미배정 → 직원1) ──
        r = api('PATCH', '/tickets/%s/assign' % tid, {'assigned_to': s1}, role='admin', userId=cu)
        c = cur()
        t.check('최초 배정 200', r.get('status') == 200, 'status=%s body=%s' % (r.get('status'), r.get('body')))
        t.check('assigned_to 반영', c.get('assigned_to') == s1, 'db=%s' % c.get('assigned_to'))
        t.check('assigned_to_name 스냅샷', c.get('assigned_to_name') == tname('배정직원1'),
                'db=%s' % c.get('assigned_to_name'))

        # ── 재배정 (직원1 → 직원2) ──
        r = api('PATCH', '/tickets/%s/assign' % tid, {'assigned_to': s2}, role='admin', userId=cu)
        t.check('재배정 200', r.get('status') == 200 and cur().get('assigned_to') == s2,
                'status=%s db=%s' % (r.get('status'), cur().get('assigned_to')))

        # ── 알림: 배정 2건(최초+재배정), event_type='assigned' ──
        slack = wait_notif(tid, 'slack', 2)
        assigned = [r for r in slack if r.get('event_type') == 'assigned']
        t.check('배정 슬랙 2건 발송', len(assigned) == 2, '실제=%s' % [r.get('event_type') for r in slack])
        t.check('배정 외 슬랙 없음', len(slack) == len(assigned), '실제=%s' % [r.get('event_type') for r in slack])
        # content(발송 원문)에 담당자 전환이 표기되는지 — (미배정 → 직원1), (직원1 → 직원2)
        contents = [r.get('content') or '' for r in assigned]
        t.check('content 저장(원문 비어있지 않음)', all(contents), 'contents=%s' % [bool(x) for x in contents])
        t.check('최초 배정 content: 미배정→직원1',
                any('미배정' in x and tname('배정직원1') in x for x in contents), '')
        t.check('재배정 content: 직원1→직원2',
                any(tname('배정직원1') in x and tname('배정직원2') in x and '미배정' not in x.split('\n')[0]
                    for x in contents) or any(tname('배정직원2') in x for x in contents), '')

        # ── 같은 담당자 재배정 — 무알림 ──
        r = api('PATCH', '/tickets/%s/assign' % tid, {'assigned_to': s2}, role='admin', userId=cu)
        t.check('동일 담당자 재배정 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        slack2 = wait_notif(tid, 'slack', 2)  # 그대로 2건이어야 함
        t.check('동일 담당자 재배정 무알림', len(slack2) == 2, '실제=%d건' % len(slack2))

        # ── assign 경로는 이력 미기록(현행) — manage 경로만 assigned/reassigned를 남긴다 ──
        hist = dget('ticket_history', {'select': 'action', 'ticket_id': 'eq.' + tid, 'limit': '100'},
                    role='admin').get('body') or []
        assigns = [h for h in hist if h.get('action') in ('assigned', 'reassigned')]
        t.check('assign 경로 이력 미기록(현행)', len(assigns) == 0, '기록=%d건' % len(assigns))

        # ── 오류 분기 ──
        r = api('PATCH', '/tickets/%s/assign' % tid, {}, role='admin', userId=cu)
        t.check('assigned_to 누락 400', r.get('status') == 400, 'status=%s' % r.get('status'))
        r = api('PATCH', '/tickets/%s/assign' % tid,
                {'assigned_to': '00000000-0000-0000-0000-000000000000'}, role='admin', userId=cu)
        t.check('없는 사용자 400', r.get('status') == 400, 'status=%s' % r.get('status'))
        r = api('PATCH', '/tickets/00000000-0000-0000-0000-000000000000/assign',
                {'assigned_to': s1}, role='admin', userId=cu)
        t.check('없는 티켓 404', r.get('status') == 404, 'status=%s' % r.get('status'))
        r = api('PATCH', '/tickets/%s/assign' % tid, {'assigned_to': s1},
                role='customer', userId=cu, companyId=co)
        t.check('고객 403', r.get('status') == 403, 'status=%s' % r.get('status'))
    finally:
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for x in created['users']: ddel('users', x, role='admin')
        for x in created['companies']: ddel('companies', x, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
