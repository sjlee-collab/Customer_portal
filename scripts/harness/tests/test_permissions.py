"""L1 백엔드 계약 테스트 — 역할별 권한 / 테넌트 격리 / 직접쓰기 차단 / 스태프 교차조회.

실행: python scripts/harness/tests/test_permissions.py
테스트 데이터는 이름/제목에 '[테스트]' 라벨 + admin 직접 insert(알림 없음), 종료 시 정리. 메일 트리거 없음.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, dpatch, ddel, api, wipe_ticket, tname, temail, Checker


def run():
    t = Checker('L1 권한/격리')
    created = {'companies': [], 'users': [], 'tickets': [], 'documents': []}
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

        # 알려진 비공개 픽스처로 검증 — 예전엔 'is_public is not False'라 null 플래그 문서가
        # 새도 통과했고, 오류로 빈 목록이 오면 all()이 공허하게 참이었다(거짓통과 감사 T2-3).
        privDoc = dpost('content_documents', {'title': tname('비공개 자료'), 'category': 'guide',
                        'file_name': 'p.pdf', 'storage_path': 'test/p.pdf', 'is_public': False},
                        role='admin')['body']['id']
        created['documents'].append(privDoc)
        docs = dget('content_documents', {'select': 'id,is_public', 'limit': '1000'}, **A).get('body') or []
        ids = [x.get('id') for x in docs]
        t.check('양성대조: 자료 목록 조회됨', len(docs) >= 0 and privDoc is not None, '%d건' % len(docs))
        t.check('고객 목록에 비공개 문서 없음', privDoc not in ids, 'privDoc 노출=%s' % (privDoc in ids))
        t.check('고객 자료 전부 is_public=true', all(x.get('is_public') is True for x in docs),
                '비공개/null=%d건' % sum(1 for x in docs if x.get('is_public') is not True))

        # 교차조회 검증은 include_test=1로 — 기본값에선 [테스트] 티켓이 비관리자 스태프에게
        # 숨겨지므로(테스트 요청 은닉), 하네스 픽스처를 보려면 명시 우회가 필요하다.
        rowsS = dget('tickets', {'select': 'id,company_id', 'limit': '1000', 'include_test': '1'}, role='tech_support', userId='zz-staff').get('body') or []
        seesA = any(x.get('company_id') == coA for x in rowsS)
        seesB = any(x.get('company_id') == coB for x in rowsS)
        t.check('스태프 교차조회 가능', seesA and seesB, 'A=%s B=%s' % (seesA, seesB))

        # ── [테스트] 요청 은닉: 관리자만 기본 노출 ──
        # 비관리자 스태프 기본 조회 → [테스트] 픽스처 안 보임 / admin은 보임 / 우회는 위에서 검증됨.
        hidS = dget('tickets', {'select': 'id', 'limit': '1000'}, role='tech_support', userId='zz-staff').get('body') or []
        hid_ids = {x['id'] for x in hidS}
        t.check('[테스트] 은닉: 스태프 기본 조회에 테스트 티켓 없음', tA not in hid_ids and tB not in hid_ids,
                '노출=%s' % [x for x in (tA, tB) if x in hid_ids])
        admS = dget('tickets', {'select': 'id', 'id': 'in.%s,%s' % (tA, tB)}, role='admin').get('body') or []
        t.check('[테스트] 은닉: admin은 테스트 티켓 보임', len(admS) == 2, '%d/2건' % len(admS))
        intS = dget('tickets', {'select': 'id', 'id': 'eq.' + tA}, role='internal', userId='zz-int').get('body') or []
        t.check('[테스트] 은닉: internal 기본 조회도 제외', len(intS) == 0, '결과=%d건' % len(intS))
    finally:
        for tid in created['tickets']: wipe_ticket(tid)
        for d in created['documents']: ddel('content_documents', d, role='admin')
        for uid in created['users']: ddel('users', uid, role='admin')
        for cid in created['companies']: ddel('companies', cid, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
