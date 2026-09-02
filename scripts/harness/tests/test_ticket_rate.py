"""L1 백엔드 계약 테스트 — 요청 완료 건 만족도 평가(POST /tickets/{id}/rate).

실행: python scripts/harness/tests/test_ticket_rate.py
검증 (rateTicket의 계약, 2026-09-01 도입):
  - 등록 고객 본인만 평가 가능(타인 403), 완료(completed) 건만(그 외 409)
  - 별점 1~5 정수 강제(0·6·비정수 400), 한줄평 200자 제한(400)
  - 정상 제출 200 + 저장 반영, 재제출은 409(조건부 UPDATE로 동시 제출도 방지)
  - 평가 제출은 updated_at을 올리지 않는다(현행 — tickets 트리거가 평가 컬럼만의
    변경을 제외하도록 수정됨. "오늘 업데이트된 요청" 집계가 평가로 부풀지 않게)
  - 없는 티켓 404

알림 없음(rate 경로는 슬랙·메일을 트리거하지 않음). 데이터는 [테스트] 라벨 + finally 정리.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, api, wipe_ticket, tname, temail, Checker


def run():
    t = Checker('L1 만족도 평가(/rate)')
    created = {'companies': [], 'users': [], 'tickets': []}
    try:
        co = dpost('companies', {'name': tname('평가 회사'), 'status': 'active'})['body']['id']
        cu = dpost('users', {'email': temail('rateCust'), 'name': tname('평가고객'), 'role': 'customer',
                             'company_id': co, 'is_active': True})['body']['id']
        other = dpost('users', {'email': temail('rateOther'), 'name': tname('평가타인'), 'role': 'customer',
                                'company_id': co, 'is_active': True})['body']['id']
        created['companies'].append(co); created['users'] += [cu, other]

        tid = dpost('tickets', {'title': tname('평가 티켓'), 'category': 'other', 'status': 'received',
                                'created_by': cu, 'company_id': co,
                                'company_name': tname('평가 회사')}, role='admin')['body']['id']
        created['tickets'].append(tid)

        def rate(body, role='customer', uid=None):
            return api('POST', '/tickets/%s/rate' % tid, body, role=role, userId=uid or cu, companyId=co)

        # 완료 전에는 평가 불가
        r = rate({'rating': 5})
        t.check('미완료 건 평가 409', r.get('status') == 409, 'status=%s' % r.get('status'))

        # 완료 처리 후 검증 계속 (send_email=False — 메일 억제)
        api('PATCH', '/tickets/%s/manage' % tid, {'status': 'completed', 'send_email': False},
            role='admin', userId=cu)
        before = (dget('tickets', {'select': 'updated_at,status', 'id': 'eq.' + tid},
                       role='admin').get('body') or [{}])[0]
        t.check('완료 전환 확인', before.get('status') == 'completed', 'status=%s' % before.get('status'))

        # 타인·범위·형식 오류
        r = rate({'rating': 5}, uid=other)
        t.check('타인 평가 403', r.get('status') == 403, 'status=%s' % r.get('status'))
        for bad in [0, 6, 3.5, '별로']:
            r = rate({'rating': bad})
            t.check('별점 %r 거부 400' % bad, r.get('status') == 400, 'status=%s' % r.get('status'))
        r = rate({'rating': 4, 'comment': '가' * 201})
        t.check('한줄평 200자 초과 400', r.get('status') == 400, 'status=%s' % r.get('status'))

        # 정상 제출 + 저장 반영
        r = rate({'rating': 4, 'comment': tname('만족')})
        t.check('평가 제출 200', r.get('status') == 200, 'status=%s body=%s' % (r.get('status'), r.get('body')))
        row = (dget('tickets', {'select': 'satisfaction_rating,satisfaction_comment,updated_at',
                                'id': 'eq.' + tid}, role='admin').get('body') or [{}])[0]
        t.check('별점 저장 반영', row.get('satisfaction_rating') == 4, 'rating=%s' % row.get('satisfaction_rating'))
        t.check('한줄평 저장 반영', (row.get('satisfaction_comment') or '').startswith('[테스트]'),
                'comment=%s' % row.get('satisfaction_comment'))
        # 평가 제출은 updated_at을 올리지 않는다(현행 트리거)
        t.check('updated_at 미변경(현행)', row.get('updated_at') == before.get('updated_at'),
                '전=%s 후=%s' % (before.get('updated_at'), row.get('updated_at')))

        # 재제출 409 + 원값 유지
        r = rate({'rating': 1, 'comment': '재시도'})
        row2 = (dget('tickets', {'select': 'satisfaction_rating', 'id': 'eq.' + tid},
                     role='admin').get('body') or [{}])[0]
        t.check('재제출 409', r.get('status') == 409, 'status=%s' % r.get('status'))
        t.check('재제출 시 원값 유지', row2.get('satisfaction_rating') == 4,
                'rating=%s' % row2.get('satisfaction_rating'))

        # 없는 티켓 404
        r = api('POST', '/tickets/00000000-0000-0000-0000-000000000000/rate', {'rating': 3},
                role='customer', userId=cu, companyId=co)
        t.check('없는 티켓 404', r.get('status') == 404, 'status=%s' % r.get('status'))
    finally:
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for x in created['users']: ddel('users', x, role='admin')
        for x in created['companies']: ddel('companies', x, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
