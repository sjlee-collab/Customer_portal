"""L1 백엔드 계약 테스트 — 역할별 권한 / 테넌트 격리 / 직접쓰기 차단 / 스태프 교차조회.

실행: python scripts/harness/tests/test_permissions.py
테스트 데이터는 이름/제목에 '[테스트]' 라벨 + admin 직접 insert(알림 없음), 종료 시 정리. 메일 트리거 없음.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, dpatch, ddel, api, wipe_ticket, tname, temail, Checker


def run():
    t = Checker('L1 권한/격리')
    created = {'companies': [], 'users': [], 'tickets': []}
    try:
        # 셋업: 회사 A/B + 고객 A/B + 티켓 A/B (admin 직접 insert = 알림 없음)
        coA = dpost('companies', {'name': tname('권한 회사A'), 'status': 'active'})['body']['id']
        coB = dpost('companies', {'name': tname('권한 회사B'), 'status': 'active'})['body']['id']
        created['companies'] += [coA, coB]
        uA = dpost('users', {'email': temail('permA'), 'name': tname('고객A'), 'role': 'customer', 'company_id': coA, 'is_active': True})['body']['id']
        uB = dpost('users', {'email': temail('permB'), 'name': tname('고객B'), 'role': 'customer', 'company_id': coB, 'is_active': True})['body']['id']
        created['users'] += [uA, uB]
        tA = dpost('tickets', {'title': tname('권한 A'), 'category': 'other', 'status': 'received', 'created_by': uA, 'company_id': coA, 'company_name': tname('권한 회사A')}, role='admin')['body']['id']
        tB = dpost('tickets', {'title': tname('권한 B'), 'category': 'other', 'status': 'received', 'created_by': uB, 'company_id': coB, 'company_name': tname('권한 회사B')}, role='admin')['body']['id']
        created['tickets'] += [tA, tB]
        A = dict(role='customer', userId=uA, companyId=coA)

        rows = dget('tickets', {'select': 'id,company_id', 'limit': '1000'}, **A).get('body') or []
        t.check('고객A 티켓=본인회사만', all(x.get('company_id') == coA for x in rows) and len(rows) >= 1, 'total=%d' % len(rows))

        rowsB = dget('tickets', {'select': 'id,company_id', 'limit': '1000'}, role='customer', userId=uB, companyId=coB).get('body') or []
        t.check('고객B가 A티켓 못봄', all(x.get('company_id') != coA for x in rowsB))

        comp = dget('companies', {'select': 'id', 'limit': '1000'}, **A).get('body') or []
        t.check('고객A 회사=본인사만', all(x.get('id') == coA for x in comp) and len(comp) >= 1, 'count=%d' % len(comp))

        r = dpatch('users', uA, {'role': 'admin'}, **A)
        role_now = (dget('users', {'select': 'role', 'id': 'eq.' + uA}, role='admin').get('body') or [{}])[0].get('role')
        t.check('권한상승 차단(role 유지)', role_now == 'customer', 'patch=%s role=%s' % (r.get('status'), role_now))

        r = dpost('tickets', {'title': tname('직접쓰기'), 'category': 'other'}, **A)
        t.check('tickets 직접 POST 차단', r.get('status') in (403, 404, 400), 'status=%s' % r.get('status'))

        r = dget('content_documents', {'select': 'id,is_public', 'limit': '1000'}, **A).get('body') or []
        t.check('고객 자료=공개만', all(x.get('is_public') is not False for x in r), 'private_leak=%d' % sum(1 for x in r if x.get('is_public') is False))

        rowsS = dget('tickets', {'select': 'id,company_id', 'limit': '1000'}, role='tech_support', userId='zz-staff').get('body') or []
        seesA = any(x.get('company_id') == coA for x in rowsS)
        seesB = any(x.get('company_id') == coB for x in rowsS)
        t.check('스태프 교차조회 가능', seesA and seesB, 'A=%s B=%s' % (seesA, seesB))
    finally:
        for tid in created['tickets']: wipe_ticket(tid)
        for uid in created['users']: ddel('users', uid, role='admin')
        for cid in created['companies']: ddel('companies', cid, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
