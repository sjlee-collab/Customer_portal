"""L1 백엔드 계약 테스트 — 요청 삭제(ticket_delete) 권한 관리 연동.

실행: python scripts/harness/tests/test_ticket_delete.py
검증: 고객 외 삭제 허용 / 고객 차단 / 자식 cascade / 권한관리 동적 토글 / 404.
role_permissions.ticket_delete 값을 잠시 토글하지만 종료 시 원복(customer=false, 그외=true).
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, dpatch, ddel, api, wipe_ticket, tname, temail, Checker


def run():
    t = Checker('L1 요청 삭제/권한연동')
    created = {'companies': [], 'users': [], 'tickets': []}
    sales_row = None
    try:
        co = dpost('companies', {'name': tname('삭제 회사'), 'status': 'active'})['body']['id']
        u = dpost('users', {'email': temail('delT'), 'name': tname('삭제고객'), 'role': 'customer', 'company_id': co, 'is_active': True})['body']['id']
        created['companies'].append(co); created['users'].append(u)

        def mk(title=None):
            tid = dpost('tickets', {'title': title or tname('삭제'), 'category': 'other', 'status': 'received', 'created_by': u, 'company_id': co, 'company_name': tname('삭제 회사')}, role='admin')['body']['id']
            created['tickets'].append(tid); return tid

        def alive(tid):
            return len(dget('tickets', {'select': 'id', 'id': 'eq.' + tid}, role='admin').get('body') or []) > 0

        # 고객 외 모든 역할 삭제 허용
        for role in ['admin', 'internal', 'sales', 'tech_support', 'education']:
            tid = mk(); r = api('DELETE', '/tickets/%s' % tid, None, role=role, userId=u)
            t.check('%s 삭제 허용(200)' % role, r.get('status') == 200 and not alive(tid), 'status=%s' % r.get('status'))

        # 고객 차단
        tc = mk(); r = api('DELETE', '/tickets/%s' % tc, None, role='customer', userId=u, companyId=co)
        t.check('고객 삭제 차단(403)', r.get('status') == 403 and alive(tc), 'status=%s' % r.get('status'))

        # 자식 cascade
        tf = mk(tname('삭제 자식'))
        # 양성대조 — 자식이 실제로 만들어졌음을 먼저 단언. 없으면 "삭제 후 0건"이 공허하게
        # 통과해 cascade가 깨져도 못 잡는다(거짓통과 감사 T2-5).
        h = dpost('ticket_history', {'ticket_id': tf, 'action': 'created', 'changed_by': u, 'changed_by_name': 'x'}, role='admin')
        rp = dpost('ticket_replies', {'ticket_id': tf, 'note': 'r', 'changed_by': u}, role='admin')
        at = dpost('ticket_attachments', {'ticket_id': tf, 'file_name': 'a.pdf', 'file_size': 1, 'storage_path': tf + '/a.pdf'}, role='admin')
        made = all(bool((x.get('body') or {}).get('id')) for x in (h, rp, at))
        t.check('양성대조: 자식 3건 생성됨', made,
                'history=%s reply=%s attach=%s' % (h.get('status'), rp.get('status'), at.get('status')))
        r = api('DELETE', '/tickets/%s' % tf, None, role='admin', userId=u)
        gone = all(len(dget(x, {'select': 'id', 'ticket_id': 'eq.' + tf}, role='admin').get('body') or []) == 0 for x in ['ticket_history', 'ticket_replies', 'ticket_attachments'])
        t.check('자식 완전삭제', r.get('status') == 200 and gone)

        # 권한 관리 동적 토글: sales OFF -> 403, ON -> 200
        sales_row = dget('role_permissions', {'select': 'id', 'role': 'eq.sales', 'feature_key': 'eq.ticket_delete'}, role='admin').get('body')[0]
        dpatch('role_permissions', sales_row['id'], {'enabled': False}, role='admin')
        td = mk(); r1 = api('DELETE', '/tickets/%s' % td, None, role='sales', userId=u)
        t.check('권한OFF시 영업 차단(403)', r1.get('status') == 403 and alive(td), 'status=%s' % r1.get('status'))
        dpatch('role_permissions', sales_row['id'], {'enabled': True}, role='admin')
        r2 = api('DELETE', '/tickets/%s' % td, None, role='sales', userId=u)
        t.check('권한ON복구시 영업 허용(200)', r2.get('status') == 200 and not alive(td), 'status=%s' % r2.get('status'))

        # 없는 티켓 404
        r = api('DELETE', '/tickets/00000000-0000-0000-0000-000000000000', None, role='admin', userId=u)
        t.check('없는 티켓 404', r.get('status') == 404, 'status=%s' % r.get('status'))
    finally:
        if sales_row:  # 안전 원복
            dpatch('role_permissions', sales_row['id'], {'enabled': True}, role='admin')
        for tid in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + tid}, role='admin').get('body') or []): wipe_ticket(tid)
        for uid in created['users']: ddel('users', uid, role='admin')
        for cid in created['companies']: ddel('companies', cid, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
