"""L1 백엔드 계약 테스트 — 내부 검토(is_internal) 은닉 보안 경계.

실행: python scripts/harness/tests/test_internal_review.py
배경: 내부 검토 티켓은 "고객에게 존재 자체가 숨겨져야" 한다(2026-09-01 도입).
      은닉은 data-api의 고객 스코프 필터 + api-layer의 메일 억제로 구현되는데,
      이 필터가 실수로 풀리면 내부 문서가 고객에게 노출된다 — 테넌트 격리와 동급의
      보안 경계라 회귀로 고정한다.

검증:
  - 생성: 대리 등록 + internal_review=true → is_internal=true.
    고객 직접 등록은 internal_review를 줘도 항상 false(대리 경로 전용)
  - 고객 은닉(data-api): 목록·id 직접조회·자식행(답글) 조회 전부 빈 결과
  - 고객 쓰기 차단(api-layer): 답글 403 · 내용수정/평가 404(존재 은닉) —
    본인 명의(created_by)인데도 어떤 경로로도 접근되면 안 된다
  - 스태프(internal)는 정상 열람
  - 메일 억제: 등록 접수확인·상태변경 메일 모두 0건 (슬랙은 정상 발송 — 스태프 인지용)
  - make_public(내부→일반 전환, 단방향·ticket_manage 필요): 고객 거부 /
    internal 403(권한 기본 false, 현행) / admin 200 → 전환 후 고객에게 보임

메일/슬랙: 전부 [테스트] 라벨 + temail 싱크. 슬랙은 테스트 채널로만 간다.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, api, wipe_ticket, notif_rows, wait_notif, tname, temail, Checker


def run():
    t = Checker('L1 내부 검토(is_internal) 은닉')
    created = {'companies': [], 'users': [], 'tickets': []}
    try:
        co = dpost('companies', {'name': tname('은닉 회사'), 'status': 'active'})['body']['id']
        cu = dpost('users', {'email': temail('hideCust'), 'name': tname('은닉고객'), 'role': 'customer',
                             'company_id': co, 'is_active': True})['body']['id']
        st = dpost('users', {'email': temail('hideStaff'), 'name': tname('은닉직원'), 'role': 'internal',
                             'is_active': True})['body']['id']
        created['companies'].append(co); created['users'] += [cu, st]
        CUST = dict(role='customer', userId=cu, companyId=co)

        # ── 생성: 내부직원이 고객 명의로 대리 + 내부 검토 ──
        r = api('POST', '/tickets', {'title': tname('내부검토 건'), 'category': 'other',
                                     'description': 'internal review', 'on_behalf_of': cu,
                                     'internal_review': True}, role='internal', userId=st)
        tk = (r.get('body') or {}).get('ticket') or {}
        tid = tk.get('id')
        if tid: created['tickets'].append(tid)
        t.check('내부검토 대리 등록 201', r.get('status') == 201 and tid, 'status=%s' % r.get('status'))
        t.check('is_internal=true', tk.get('is_internal') is True, 'is_internal=%s' % tk.get('is_internal'))
        t.check('created_by=고객(명의)', tk.get('created_by') == cu, 'created_by=%s' % tk.get('created_by'))

        # 고객 직접 등록은 internal_review를 줘도 무시(대리 경로 전용)
        r2 = api('POST', '/tickets', {'title': tname('고객이 내부검토 시도'), 'category': 'other',
                                      'description': 'x', 'internal_review': True}, **CUST)
        tk2 = (r2.get('body') or {}).get('ticket') or {}
        if tk2.get('id'): created['tickets'].append(tk2['id'])
        t.check('고객 등록은 is_internal=false 강제', r2.get('status') == 201 and tk2.get('is_internal') is False,
                'status=%s is_internal=%s' % (r2.get('status'), tk2.get('is_internal')))

        # ── 고객 은닉 (본인 명의인데도 어떤 경로로도 안 보여야 함) ──
        rows = dget('tickets', {'select': 'id,title', 'limit': '200'}, **CUST).get('body') or []
        t.check('고객 목록에서 은닉', tid not in [x.get('id') for x in rows],
                '목록 %d건에 노출 여부' % len(rows))
        rows = dget('tickets', {'select': 'id', 'id': 'eq.' + tid}, **CUST).get('body') or []
        t.check('고객 id 직접조회 은닉', len(rows) == 0, '결과=%d건' % len(rows))

        # 자식행: 스태프가 답글을 달아두고, 고객이 그 답글을 못 보는지
        dpost('ticket_replies', {'ticket_id': tid, 'note': tname('내부 답글'), 'changed_by': st}, role='admin')
        rows = dget('ticket_replies', {'select': 'id', 'ticket_id': 'eq.' + tid}, **CUST).get('body') or []
        t.check('고객 자식행(답글) 은닉', len(rows) == 0, '결과=%d건' % len(rows))

        # 쓰기 차단: 본인 명의 티켓이지만 어떤 쓰기 경로도 뚫리면 안 된다.
        # (2026-09-01 하네스로 발견 — api-layer 사본에 is_internal 필터가 빠져 답글 201,
        #  editTicket은 isOwner만 봐서 내용 수정까지 가능했다. 수정 후 답글 403 / 수정·평가 404)
        r = api('POST', '/tickets/%s/reply' % tid, {'note': tname('고객 답글 시도')}, **CUST)
        t.check('고객 답글 쓰기 403', r.get('status') == 403, 'status=%s' % r.get('status'))
        r = api('PATCH', '/tickets/%s' % tid, {'title': tname('탈취 수정'), 'category': 'other',
                                               'description': 'x'}, **CUST)
        t.check('고객 내용 수정 404(존재 은닉)', r.get('status') == 404, 'status=%s' % r.get('status'))
        r = api('POST', '/tickets/%s/rate' % tid, {'rating': 5}, **CUST)
        t.check('고객 평가 404(존재 은닉)', r.get('status') == 404, 'status=%s' % r.get('status'))

        # ── 스태프는 정상 열람 ──
        rows = dget('tickets', {'select': 'id', 'id': 'eq.' + tid}, role='internal', userId=st).get('body') or []
        t.check('내부직원 조회 가능', len(rows) == 1, '결과=%d건' % len(rows))

        # ── 알림: 슬랙은 발송(스태프 인지용), 메일은 접수확인부터 0건 ──
        slack = wait_notif(tid, 'slack', 1)
        t.check('등록 슬랙 발송(스태프 인지)', len(slack) >= 1,
                '실제=%s' % [x.get('event_type') for x in slack])
        t.check('접수확인 메일 억제', len(notif_rows(tid, 'email')) == 0,
                '실제=%d건' % len(notif_rows(tid, 'email')))

        # 상태 변경 메일도 억제 (슬랙은 발송)
        api('PATCH', '/tickets/%s/status' % tid, {'status': 'in_progress'}, role='admin', userId=st)
        wait_notif(tid, 'slack', len(slack) + 1)
        t.check('상태변경 메일 억제', len(notif_rows(tid, 'email')) == 0,
                '실제=%d건' % len(notif_rows(tid, 'email')))

        # ── make_public: 내부 → 일반 전환(단방향, ticket_manage 필요) ──
        r = api('PATCH', '/tickets/%s' % tid, {'make_public': True}, **CUST)
        t.check('고객의 전환 시도 거부', r.get('status') in (403, 404), 'status=%s' % r.get('status'))
        # internal 역할은 ticket_manage 기본 false라 전환 불가(현행) — 전환은 admin/영업/기술지원만
        r = api('PATCH', '/tickets/%s' % tid, {'make_public': True}, role='internal', userId=st)
        t.check('internal 전환 403(ticket_manage 없음, 현행)', r.get('status') == 403,
                'status=%s' % r.get('status'))
        r = api('PATCH', '/tickets/%s' % tid, {'make_public': True}, role='admin', userId=st)
        t.check('admin 전환 200 + is_internal=false',
                r.get('status') == 200 and (r.get('body') or {}).get('ticket', {}).get('is_internal') is False,
                'status=%s' % r.get('status'))
        rows = dget('tickets', {'select': 'id', 'id': 'eq.' + tid}, **CUST).get('body') or []
        t.check('전환 후 고객에게 보임', len(rows) == 1, '결과=%d건' % len(rows))
    finally:
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for x in created['users']: ddel('users', x, role='admin')
        for x in created['companies']: ddel('companies', x, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
