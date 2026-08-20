"""L1-C 고객 기능 정상성 테스트 — 고객 계정으로 전 기능이 정상 동작하는지 + 보안 차단.

실행: python scripts/harness/tests/test_customer_e2e.py
고객 컨텍스트로 요청 등록/조회/상세/수정/답글/첨부/계약·자료 조회/내정보 수정을 실행하고,
삭제·격리·권한상승·스태프테이블 접근이 차단되는지 확인한다. 종료 시 정리.

메일 주의: '요청 등록'은 api-layer 실제 경로라 접수 확인 메일이 발송된다. 테스트 고객 이메일은
sjlee+ (sink) 주소라 실고객엔 가지 않는다. 완전 무발송을 원하면 email-safe.sh on 상태로 실행.
로그인: 엔드포인트 동작(비파괴)만 검증. 실로그인(비번)까지는 초대→재설정 토큰 경로 필요(미포함).
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import invoke, dget, dpost, dpatch, ddel, api, wipe_ticket, tname, temail, Checker
import json


def run():
    t = Checker('L1-C 고객 기능 정상성')
    created = {'companies': [], 'users': [], 'tickets': [], 'contracts': [], 'licenses': [], 'docs': []}
    try:
        co = dpost('companies', {'name': tname('고객 회사'), 'status': 'active'})['body']['id']
        coX = dpost('companies', {'name': tname('고객 타사'), 'status': 'active'})['body']['id']
        created['companies'] += [co, coX]
        ct = dpost('company_contracts', {'company_id': co, 'contract_name': tname('고객 계약'), 'status': '진행중'}, role='admin')['body']['id']
        created['contracts'].append(ct)
        lic = dpost('company_licenses', {'company_id': co, 'contract_id': ct, 'product_info': 'Tableau Server', 'license_type': 'Creator', 'quantity': 5, 'status': '활성'}, role='admin')['body']['id']
        created['licenses'].append(lic)
        u = dpost('users', {'email': temail('custE2E'), 'name': tname('고객E2E'), 'role': 'customer', 'company_id': co, 'contract_id': ct, 'is_active': True})['body']['id']
        uX = dpost('users', {'email': temail('custX'), 'name': tname('타사고객'), 'role': 'customer', 'company_id': coX, 'is_active': True})['body']['id']
        created['users'] += [u, uX]
        tX = dpost('tickets', {'title': tname('타사티켓'), 'category': 'other', 'status': 'received', 'created_by': uX, 'company_id': coX, 'company_name': tname('고객 타사')}, role='admin')['body']['id']
        created['tickets'].append(tX)
        privDoc = dpost('content_documents', {'title': tname('비공개자료'), 'category': 'tableau', 'product': 'doc', 'file_name': '', 'storage_path': '', 'is_public': False}, role='admin')['body']['id']
        created['docs'].append(privDoc)
        C = dict(role='customer', userId=u, companyId=co, contractId=ct)

        # 1) 요청 등록 (실제 경로)
        r = api('POST', '/tickets', {'title': tname('신규요청'), 'category': 'other', 'description': '테스트 내용', 'priority': 'normal'}, **C)
        myTid = r.get('body', {}).get('ticket', {}).get('id') if r.get('status') == 201 else None
        if myTid: created['tickets'].append(myTid)
        t.check('요청 등록(201)', r.get('status') == 201 and myTid, 'status=%s' % r.get('status'))

        # 2) 요청 목록 — 본인 것 보임
        rows = dget('tickets', {'select': 'id', 'limit': '1000'}, **C).get('body') or []
        t.check('요청 목록에 본인 요청 노출', myTid in [x['id'] for x in rows])

        # 3) 요청 상세 — 본인 티켓/자식 조회
        det = dget('tickets', {'select': 'id,title', 'id': 'eq.' + (myTid or '')}, **C).get('body') or []
        t.check('요청 상세 조회', len(det) == 1)

        # 4) 요청 수정 (본인)
        if myTid:
            new_title = tname('수정됨')
            r = api('PATCH', '/tickets/%s' % myTid, {'title': new_title, 'category': 'other', 'description': '테스트 수정내용'}, **C)
            title_now = (dget('tickets', {'select': 'title', 'id': 'eq.' + myTid}, role='admin').get('body') or [{}])[0].get('title')
            t.check('요청 수정(200)', r.get('status') == 200 and title_now == new_title, 'status=%s' % r.get('status'))

            # 5) 답글
            r = api('POST', '/tickets/%s/reply' % myTid, {'note': tname('고객 답글')}, **C)
            t.check('답글 작성(201)', r.get('status') == 201, 'status=%s' % r.get('status'))

            # 6) 첨부(본인 티켓)
            r = dpost('ticket_attachments', {'ticket_id': myTid, 'file_name': 'zz.pdf', 'file_size': 1, 'storage_path': myTid + '/zz.pdf'}, **C)
            t.check('첨부 추가(2xx)', str(r.get('status')).startswith('20'), 'status=%s' % r.get('status'))

        # 7) 계약/라이선스 — 본인 회사만
        cts = dget('company_contracts', {'select': 'id,company_id', 'limit': '100'}, **C).get('body') or []
        t.check('계약 조회=본인회사만', all(x.get('company_id') == co for x in cts) and len(cts) >= 1, 'count=%d' % len(cts))
        lics = dget('company_licenses', {'select': 'id,company_id', 'limit': '100'}, **C).get('body') or []
        t.check('라이선스 조회=본인회사만', all(x.get('company_id') == co for x in lics))

        # 8) 자료실 — 공개만(비공개 안 보임)
        docs = dget('content_documents', {'select': 'id,is_public', 'limit': '1000'}, **C).get('body') or []
        t.check('자료실=공개만', privDoc not in [x['id'] for x in docs] and all(x.get('is_public') is not False for x in docs))

        # 9) 내 정보 수정 (이름/연락처)
        edited_name = tname('고객수정')
        r = dpatch('users', u, {'phone': '010-0000-0000', 'name': edited_name}, **C)
        chk = (dget('users', {'select': 'name,phone', 'id': 'eq.' + u}, role='admin').get('body') or [{}])[0]
        t.check('내 정보 수정 반영', chk.get('name') == edited_name and chk.get('phone') == '010-0000-0000', 'status=%s' % r.get('status'))

        # 10) 로그인 엔드포인트(비파괴)
        ls = invoke('api', {'requestContext': {'http': {'method': 'POST'}}, 'rawPath': '/auth/login', 'body': json.dumps({'email': 'zz-nope@example.com', 'password': 'x'})})
        t.check('로그인 엔드포인트 정상(없는계정 404)', ls.get('status') == 404, 'status=%s' % ls.get('status'))

        # --- 보안 차단(있어야 함) ---
        if myTid:
            r = api('DELETE', '/tickets/%s' % myTid, None, **C)
            t.check('고객 요청 삭제 차단(403)', r.get('status') == 403, 'status=%s' % r.get('status'))
        seesX = tX in [x['id'] for x in (dget('tickets', {'select': 'id', 'limit': '1000'}, **C).get('body') or [])]
        t.check('타사 티켓 격리(안 보임)', not seesX)
        r = dpatch('users', u, {'role': 'admin'}, **C)
        t.check('권한상승 차단', (dget('users', {'select': 'role', 'id': 'eq.' + u}, role='admin').get('body') or [{}])[0].get('role') == 'customer')
        r = dget('org_units', {'select': 'id', 'limit': '10'}, **C)
        t.check('스태프 테이블(org_units) 차단', r.get('status') in (403, 404), 'status=%s' % r.get('status'))
        r = api('PATCH', '/tickets/%s' % tX, {'title': tname('타사수정시도'), 'category': 'other', 'description': 'x'}, **C)
        t.check('타사 티켓 수정 차단', r.get('status') in (403, 404), 'status=%s' % r.get('status'))
    finally:
        for tid in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + tid}, role='admin').get('body') or []): wipe_ticket(tid)
        for did in created['docs']: ddel('content_documents', did, role='admin')
        for lid in created['licenses']: ddel('company_licenses', lid, role='admin')
        # users.contract_id → company_contracts FK: 유저를 계약보다 먼저 삭제해야 함
        for uid in created['users']: ddel('users', uid, role='admin')
        for cid2 in created['contracts']: ddel('company_contracts', cid2, role='admin')
        for cid in created['companies']: ddel('companies', cid, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
