"""L1 백엔드 계약 테스트 — 요청 상태 변경(접수 제외 전 상태).

실행: python scripts/harness/tests/test_ticket_status.py
대상 상태: classifying / in_progress / pending_customer / on_hold / completed / cancelled
          (초기값 'received'(접수)는 생성 시점 값이라 전이 대상에서 제외)

검증:
  - 두 경로(PATCH /tickets/{id}/status, PATCH /tickets/{id}/manage) 모두에서
    6개 상태 전이가 실제 저장되는지
  - 상태별 슬랙 알림 — 접수 제외 6개 상태 전부 발송되어야 한다.
    event_type은 completed / pending_customer만 고유 라벨이고 나머지 4개는 status_change.
    (api-layer SLACK_STATUS_CHANGE 화이트리스트가 좁아지면 여기서 잡힌다)
  - 메일도 상태 필터 없이 전 상태에 발송
  - 이력(ticket_history.status_changed)은 manage 경로만 기록한다는 현행 차이를 고정
  - 고객 역할은 전 상태에서 403 차단 / 같은 상태 재저장은 무알림 / 잘못된 상태값 거부
  - 슬랙 발송 원문이 log_notification.content에 저장되는지
  - 완료예정일 초과(TICKET_OVERDUE): 기한 지난 티켓의 상태 변경 시 상태 알림과 별개로
    1건 추가 발송, 마감 당일은 초과 아님(날짜만 비교), completed 전환 시는 미발송

관찰 방법: 알림은 deferNotify(InvocationType='Event') 비동기라 응답으로 확인할 수 없다.
api-layer notify.mjs가 발송 결과를 log_notification에 남기므로 그 행으로 판정한다
(웹훅 미설정이어도 status='failure' 행은 남으므로 '라우팅 결정' 자체는 검증된다).

메일 주의: 상태 경로는 상태 변경마다 고객에게 메일이 나간다. 요청자 이메일은 temail() 싱크라
실행당 6통이 sjlee 싱크로 들어온다(manage 경로는 send_email=False로 억제). 슬랙은 '[테스트]'
라벨 덕에 테스트 채널로만 간다.
"""
import sys, os
from collections import Counter
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, api, wipe_ticket, notif_rows, wait_notif, tname, temail, Checker

# 접수(received)를 제외한 전 상태 — schema.sql tickets.status CHECK 기준.
STATUSES = ['classifying', 'in_progress', 'pending_customer', 'on_hold', 'completed', 'cancelled']
# 상태 → log_notification.event_type (배포본 notify-handler handleTicketStatus 기준).
# 6개 상태 모두 슬랙이 나가며, 완료/고객확인만 고유 라벨이고 나머지는 status_change.
SLACK_EVENT = {
    'classifying':      'status_change',
    'in_progress':      'status_change',
    'pending_customer': 'pending_customer',
    'on_hold':          'status_change',
    'completed':        'completed',
    'cancelled':        'status_change',
}
EXPECT_SLACK = Counter(SLACK_EVENT[s] for s in STATUSES)


def cur_status(tid):
    rows = dget('tickets', {'select': 'status', 'id': 'eq.' + tid}, role='admin').get('body') or []
    return rows[0]['status'] if rows else None


def history_rows(tid):
    rows = dget('ticket_history', {'select': 'id,action,note', 'ticket_id': 'eq.' + tid, 'limit': '200'},
                role='admin').get('body') or []
    return [r for r in rows if r.get('action') == 'status_changed']


def run():
    t = Checker('L1 요청 상태 변경(접수 제외 전 상태)')
    created = {'companies': [], 'users': [], 'tickets': []}
    try:
        co = dpost('companies', {'name': tname('상태 회사'), 'status': 'active'})['body']['id']
        u = dpost('users', {'email': temail('statusT'), 'name': tname('상태고객'), 'role': 'customer',
                            'company_id': co, 'is_active': True})['body']['id']
        created['companies'].append(co); created['users'].append(u)

        def mk(label):
            # category='other' — 공통 채널만 타게 한다(education이면 교육 채널로 한 건 더 나감).
            tid = dpost('tickets', {'title': tname(label), 'category': 'other', 'status': 'received',
                                    'created_by': u, 'company_id': co,
                                    'company_name': tname('상태 회사')}, role='admin')['body']['id']
            created['tickets'].append(tid); return tid

        # ── A) PATCH /tickets/{id}/status — 상태 단독 변경 ──────────────────
        # 알림은 트리거 시점 스냅샷을 페이로드로 받아 처리하므로(2026-09-03 B 수정),
        # 전이를 연속으로 쏴도 라벨이 밀리지 않는다 — 정착 대기 없이 결정적이어야 한다.
        tA = mk('상태 경로')
        for i, s in enumerate(STATUSES, 1):
            r = api('PATCH', '/tickets/%s/status' % tA, {'status': s}, role='admin', userId=u)
            t.check('[status] %s 전이 200' % s, r.get('status') == 200,
                    'status=%s body=%s' % (r.get('status'), r.get('body')))
            t.check('[status] %s 저장 반영' % s, cur_status(tA) == s, 'db=%s' % cur_status(tA))
            # (정착 대기 제거 — 알림이 스냅샷 기반이 되어 연속 전이에도 라벨이 안 밀린다)

        # 고객은 전 상태에서 차단(ticket_manage 권한 없음)
        for s in STATUSES:
            r = api('PATCH', '/tickets/%s/status' % tA, {'status': s},
                    role='customer', userId=u, companyId=co)
            t.check('[status] %s 고객 차단(403)' % s, r.get('status') == 403, 'status=%s' % r.get('status'))

        # 같은 상태 재저장 — prevStatus === status라 알림이 나가면 안 된다
        r = api('PATCH', '/tickets/%s/status' % tA, {'status': 'cancelled'}, role='admin', userId=u)
        t.check('[status] 동일 상태 재저장 200', r.get('status') == 200, 'status=%s' % r.get('status'))

        # 잘못된 상태값 — CHECK 제약 위반이라 저장되면 안 된다(응답 코드는 현행을 기록만)
        bad = api('PATCH', '/tickets/%s/status' % tA, {'status': '없는상태'}, role='admin', userId=u)
        t.check('[status] 잘못된 상태값 거부', bad.get('status') != 200 and cur_status(tA) == 'cancelled',
                'status=%s db=%s' % (bad.get('status'), cur_status(tA)))
        # status 누락
        miss = api('PATCH', '/tickets/%s/status' % tA, {}, role='admin', userId=u)
        t.check('[status] status 누락 400', miss.get('status') == 400, 'status=%s' % miss.get('status'))

        # 이력: status 경로는 ticket_history를 남기지 않는다(manage 경로와의 현행 차이 고정)
        hA = history_rows(tA)
        t.check('[status] 이력 미기록(현행)', len(hA) == 0, 'status_changed=%d건' % len(hA))

        # 알림 판정 — 접수 제외 6개 상태 전부 슬랙 발송
        slack = wait_notif(tA, 'slack', len(STATUSES))
        got = Counter(r.get('event_type') for r in slack)
        t.check('[status] 슬랙 %d건(전 상태) 발송' % len(STATUSES), len(slack) == len(STATUSES),
                '기대=%d 실제=%d (%s)' % (len(STATUSES), len(slack), dict(got)))
        t.check('[status] 슬랙 이벤트타입 분포 일치', got == EXPECT_SLACK,
                '기대=%s 실제=%s' % (dict(EXPECT_SLACK), dict(got)))
        for s in STATUSES:
            ev = SLACK_EVENT[s]
            t.check('[status] %s 슬랙 발송(%s)' % (s, ev), got.get(ev, 0) >= 1, '실제=%s' % dict(got))

        # 메일도 상태 필터 없이 6개 상태 전부 발송
        mail = notif_rows(tA, 'email')
        t.check('[status] 메일 전 상태 발송(%d건)' % len(STATUSES), len(mail) == len(STATUSES),
                '기대=%d 실제=%d' % (len(STATUSES), len(mail)))

        # ── B) PATCH /tickets/{id}/manage — 관리 모달 경로 ──────────────────
        tB = mk('관리 경로')
        for i, s in enumerate(STATUSES, 1):
            r = api('PATCH', '/tickets/%s/manage' % tB, {'status': s, 'send_email': False},
                    role='admin', userId=u)
            t.check('[manage] %s 전이 200' % s, r.get('status') == 200,
                    'status=%s body=%s' % (r.get('status'), r.get('body')))
            t.check('[manage] %s 저장 반영' % s, cur_status(tB) == s, 'db=%s' % cur_status(tB))
            hs = history_rows(tB)
            t.check('[manage] %s 이력 기록(%d건)' % (s, i), len(hs) == i,
                    '기대=%d 실제=%d' % (i, len(hs)))
            # (정착 대기 제거 — 스냅샷 알림으로 불필요)

        for s in STATUSES:
            r = api('PATCH', '/tickets/%s/manage' % tB, {'status': s, 'send_email': False},
                    role='customer', userId=u, companyId=co)
            t.check('[manage] %s 고객 차단(403)' % s, r.get('status') == 403, 'status=%s' % r.get('status'))

        slackB = wait_notif(tB, 'slack', len(STATUSES))
        gotB = Counter(r.get('event_type') for r in slackB)
        t.check('[manage] 슬랙 %d건(전 상태) 발송' % len(STATUSES), len(slackB) == len(STATUSES),
                '기대=%d 실제=%d (%s)' % (len(STATUSES), len(slackB), dict(gotB)))
        t.check('[manage] 슬랙 이벤트타입 분포 일치', gotB == EXPECT_SLACK,
                '기대=%s 실제=%s' % (dict(EXPECT_SLACK), dict(gotB)))
        for s in STATUSES:
            ev = SLACK_EVENT[s]
            t.check('[manage] %s 슬랙 발송(%s)' % (s, ev), gotB.get(ev, 0) >= 1, '실제=%s' % dict(gotB))

        # send_email=False면 메일은 한 통도 나가면 안 된다
        mailB = notif_rows(tB, 'email')
        t.check('[manage] send_email=False 메일 미발송', len(mailB) == 0, '실제=%d건' % len(mailB))

        # content(발송 원문) 저장 — 슬랙 mrkdwn이 log_notification.content에 남는다
        contents = [r.get('content') or '' for r in slackB]
        t.check('[manage] 슬랙 content 저장', all(contents) and any('상태 변경' in x for x in contents),
                '빈 content=%d건' % sum(1 for x in contents if not x))

        # ── C) 완료예정일 초과(TICKET_OVERDUE) — 날짜만 비교(당일은 초과 아님) ──
        import datetime
        kst_today = (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).date()
        yesterday = (kst_today - datetime.timedelta(days=1)).isoformat()

        # 기한이 어제인 티켓: 상태 변경 시 status_change + overdue 2건이 나가야 한다
        tC = mk('기한초과')
        api('PATCH', '/tickets/%s/manage' % tC,
            {'status': 'received', 'due_date': yesterday, 'send_email': False}, role='admin', userId=u)
        r = api('PATCH', '/tickets/%s/manage' % tC,
                {'status': 'in_progress', 'due_date': yesterday, 'send_email': False}, role='admin', userId=u)
        t.check('[overdue] 상태 변경 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        slackC = wait_notif(tC, 'slack', 2)
        evC = Counter(x.get('event_type') for x in slackC)
        t.check('[overdue] 기한 지난 티켓: 상태+초과 2건', evC.get('status_change', 0) == 1 and evC.get('overdue', 0) == 1,
                '실제=%s' % dict(evC))

        # 기한이 오늘인 티켓: 당일은 초과가 아니므로 상태 변경 1건만
        tD = mk('기한당일')
        api('PATCH', '/tickets/%s/manage' % tD,
            {'status': 'received', 'due_date': kst_today.isoformat(), 'send_email': False}, role='admin', userId=u)
        r = api('PATCH', '/tickets/%s/manage' % tD,
                {'status': 'in_progress', 'due_date': kst_today.isoformat(), 'send_email': False},
                role='admin', userId=u)
        t.check('[overdue] 당일 상태 변경 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        slackD = wait_notif(tD, 'slack', 1)
        evD = Counter(x.get('event_type') for x in slackD)
        t.check('[overdue] 마감 당일은 초과 아님(1건만)', evD.get('overdue', 0) == 0 and evD.get('status_change', 0) == 1,
                '실제=%s' % dict(evD))

        # 기한 지난 티켓이라도 completed로 바꾸면 초과 알림은 안 나간다
        r = api('PATCH', '/tickets/%s/manage' % tC,
                {'status': 'completed', 'due_date': yesterday, 'send_email': False}, role='admin', userId=u)
        slackC2 = wait_notif(tC, 'slack', 3)
        evC2 = Counter(x.get('event_type') for x in slackC2)
        t.check('[overdue] 완료 전환 시 초과 미발송', evC2.get('overdue', 0) == 1 and evC2.get('completed', 0) == 1,
                '실제=%s' % dict(evC2))
    finally:
        for tid in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + tid}, role='admin').get('body') or []):
                wipe_ticket(tid)
        for uid in created['users']: ddel('users', uid, role='admin')
        for cid in created['companies']: ddel('companies', cid, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
