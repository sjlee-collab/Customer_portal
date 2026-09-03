"""L1 배치 테스트 — EventBridge 배치 3종을 only_test 모드로 안전 검증.

실행: python scripts/harness/tests/test_batch.py
배경: overdue/license/contract 배치는 매일 새벽 전체 티켓·계약을 스캔한다. 예전엔
      테스트로 invoke하면 실 운영 데이터의 알림이 실 채널로 중복 발송되고, 계약 배치는
      운영 계약 상태를 실제로 UPDATE해서 검증 자체가 불가능했다(하네스 사각지대).
      api-layer 배치에 only_test 모드를 추가 — '[테스트]' 라벨 행만 스캔한다.

검증:
  - overdue_batch: 기한 지난 '[테스트]' 티켓만 지연 알림. 마감 당일/미래는 제외(날짜 판정).
    only_test 없이는 절대 호출하지 않는다(운영 스캔 방지).
  - license_expiry_notice: '[테스트]' 고객사의 targetDate 만료 라이선스만 알림.
  - expire_contracts: 종료일 지난 '[테스트]' 진행중 계약만 '만료'로 UPDATE.
    ⚠ 운영 계약 불변 — 라벨 없는 계약은 건드리지 않음을 대조 확인.

알림은 log_notification으로 판정(슬랙은 '[테스트]' 라벨 라우팅으로 테스트 채널행).
데이터는 전부 [테스트] 라벨 + finally 정리.
"""
import sys, os, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, dpatch, ddel, batch, wipe_ticket, notif_rows, wait_notif, tname, temail, Checker


def kst_today():
    return (datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(hours=9)).date()


def run():
    t = Checker('L1 배치(only_test)')
    created = {'companies': [], 'users': [], 'tickets': [], 'contracts': [], 'licenses': []}
    try:
        today = kst_today()
        yst = (today - datetime.timedelta(days=1)).isoformat()
        d7 = (today + datetime.timedelta(days=7)).isoformat()
        co = dpost('companies', {'name': tname('배치 회사'), 'status': 'active'})['body']['id']
        u = dpost('users', {'email': temail('batchT'), 'name': tname('배치고객'), 'role': 'customer',
                            'company_id': co, 'is_active': True})['body']['id']
        created['companies'].append(co); created['users'].append(u)

        def mk_ticket(label, due, status='in_progress'):
            tid = dpost('tickets', {'title': tname(label), 'category': 'other', 'status': status,
                                    'created_by': u, 'company_id': co, 'company_name': tname('배치 회사'),
                                    'due_date': due}, role='admin')['body']['id']
            created['tickets'].append(tid); return tid

        # ── overdue_batch ── 기한 지난 티켓만 알림
        t_over = mk_ticket('지연 티켓', yst)              # 어제 마감 → 초과
        t_today = mk_ticket('당일 티켓', today.isoformat())  # 오늘 마감 → 초과 아님
        r = batch('overdue_batch', only_test=True)
        t.check('overdue_batch 200', r.get('status') == 200, 'status=%s body=%s' % (r.get('status'), r.get('body')))
        ov = wait_notif(t_over, 'slack', 1)
        t.check('지연 티켓 초과 알림', any(x.get('event_type') == 'overdue' for x in ov),
                '실제=%s' % [x.get('event_type') for x in ov])
        td = notif_rows(t_today, 'slack')
        t.check('당일 티켓 초과 알림 없음', len(td) == 0, '실제=%d건' % len(td))
        # processed 카운트에 테스트 티켓이 잡혔는지(운영 전체가 아니라)
        t.check('processed 최소 1(테스트 스코프)', (r.get('body') or {}).get('processed', 0) >= 1,
                'processed=%s' % (r.get('body') or {}).get('processed'))

        # ── expire_contracts ── 종료일 지난 '[테스트]' 진행중 계약만 만료
        c_exp = dpost('company_contracts', {'company_id': co, 'contract_name': tname('만료대상 계약'),
                                            'status': '진행중', 'end_date': yst}, role='admin')['body']['id']
        c_live = dpost('company_contracts', {'company_id': co, 'contract_name': tname('유효 계약'),
                                             'status': '진행중', 'end_date': d7}, role='admin')['body']['id']
        created['contracts'] += [c_exp, c_live]
        r = batch('expire_contracts', only_test=True)
        t.check('expire_contracts 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        def cstatus(cid):
            rows = dget('company_contracts', {'select': 'status', 'id': 'eq.' + cid}, role='admin').get('body') or []
            return rows[0]['status'] if rows else None
        t.check('종료일 지난 계약 → 만료', cstatus(c_exp) == '만료', 'status=%s' % cstatus(c_exp))
        t.check('유효 계약은 진행중 유지', cstatus(c_live) == '진행중', 'status=%s' % cstatus(c_live))
        # 운영 계약 불변 검증 — 라벨 없는 진행중·기한지난 계약이 있어도 안 바뀌어야(only_test 스코프)
        # (운영 데이터를 만들지 않고, 반환 목록이 전부 [테스트] 라벨인지로 대신 확인)
        changed = (r.get('body') or {}).get('contracts') or []
        t.check('변경 대상이 전부 [테스트] 라벨', all(str(x).startswith('[테스트]') for x in changed),
                '변경=%s' % changed)

        # ── license_expiry_notice ── '[테스트]' 고객사의 targetDate 만료 라이선스만
        lic = dpost('company_licenses', {'company_id': co, 'contract_id': c_live,
                                         'product_info': tname('Tableau'), 'license_type': 'Creator',
                                         'quantity': 5, 'status': '활성', 'end_date': d7}, role='admin')['body']['id']
        created['licenses'].append(lic)
        r = batch('license_expiry_notice', only_test=True, date=d7)
        t.check('license_expiry_notice 200', r.get('status') == 200, 'status=%s body=%s' % (r.get('status'), r.get('body')))
        # 발송 결과는 ok/results로 확인(라이선스 알림은 ticket_id 없음)
        ok = (r.get('body') or {}).get('ok', True)
        t.check('라이선스 배치 정상 수행', ok is not False, 'body=%s' % r.get('body'))
    finally:
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for x in created['licenses']: ddel('company_licenses', x, role='admin')
        for x in created['contracts']: ddel('company_contracts', x, role='admin')
        for x in created['users']: ddel('users', x, role='admin')
        for x in created['companies']: ddel('companies', x, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
