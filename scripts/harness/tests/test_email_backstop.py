"""L1 이메일 [테스트] 백스톱 — 테스트 티켓의 메일이 실 수신자(관리자·영업)에게 새지 않는지.

실행: python scripts/harness/tests/test_email_backstop.py
배경: 슬랙은 notify-handler가 [테스트] 라벨을 직접 보고 테스트 채널로 재라우팅하지만,
      이메일(send-email)엔 그 백스톱이 없어 오직 호출자가 넘긴 수신자에만 의존했다.
      티켓 생성 시 getAdminEmails()/getAccountManagerEmail()은 요청자(temail 싱크)와 달리
      **실 관리자·영업 주소**를 끌어오므로, [테스트] 긴급/계약 티켓이면 실 직원에게 메일이
      갈 수 있었다(2026-09-04 격리 감사에서 발견). send-email에 [테스트] 판정→싱크 리다이렉트
      백스톱을 추가(EMAIL_TEST_SINK)해 이 스위트로 고정한다.

검증: [테스트] 회사의 고객이 priority=critical 티켓을 접수 → api-layer가 실 관리자 주소로
      'urgent' 메일을 트리거. 그 메일 로그가
      (1) 실제로 실 관리자 주소를 수신자로 가짐(구멍이 구조적으로 존재함을 증명)
      (2) 그럼에도 전부 is_test=true로 기록됨(백스톱이 개입해 싱크로 돌렸음을 증명).
      백스톱이 없다면 (2)가 false가 되어 실 관리자 받은편지함으로 갔을 것.

데이터: [테스트] 회사·고객(temail). critical 메일은 백스톱 덕에 싱크로만 감(실 발송 없음).
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, api, wipe_ticket, wait_notif, notif_rows, tname, temail, Checker


def email_rows(ticket_id):
    """log_notification의 이 티켓 이메일 행 — is_test 포함(notif_rows는 is_test 미포함)."""
    return dget('log_notification',
                {'select': 'event_type,recipient,status,is_test',
                 'ticket_id': 'eq.' + ticket_id, 'channel': 'eq.email'},
                role='admin').get('body') or []


def run():
    t = Checker('L1 이메일 [테스트] 백스톱')
    co_id = uid = tid = None
    try:
        # 실 관리자 주소 목록 — 백스톱이 없었다면 이리로 갔을 대상.
        admins = {u['email'] for u in (dget('users', {'select': 'email', 'role': 'eq.admin',
                  'is_active': 'eq.true'}, role='admin').get('body') or []) if u.get('email')}
        t.check('전제: 실 관리자 계정 존재', len(admins) > 0, '%d명' % len(admins))

        co = dpost('companies', {'name': tname('백스톱 회사'), 'status': 'active'}, role='admin')['body']
        co_id = co['id']
        u = dpost('users', {'email': temail('backstop'), 'name': tname('백스톱고객'), 'role': 'customer',
                            'company_id': co_id, 'is_active': True}, role='admin')['body']
        uid = u['id']

        # 고객이 긴급 티켓 접수 — api-layer가 getAdminEmails()로 실 관리자에게 urgent 메일 트리거.
        r = api('POST', '/tickets', {'title': tname('긴급 백스톱'), 'category': 'other',
                'priority': 'critical', 'description': '백스톱 검증'}, role='customer', userId=uid)
        t.check('긴급 티켓 접수 201', r.get('status') == 201, 'status=%s' % r.get('status'))
        tid = (r.get('body') or {}).get('ticket', {}).get('id')

        # 접수확인(고객) + urgent(관리자/영업) 메일이 로그에 남을 때까지 대기.
        wait_notif(tid, 'email', 2, grace_sec=4)
        rows = email_rows(tid)
        t.check('이메일 로그 기록됨', len(rows) >= 1, '%d건' % len(rows))

        urgent = [x for x in rows if x.get('event_type') == 'urgent']
        t.check('긴급 관리자 메일 트리거됨(urgent)', len(urgent) >= 1,
                '%d건 / 이벤트=%s' % (len(urgent), sorted({x.get('event_type') for x in rows})))

        # (1) 구멍이 구조적으로 존재: 수신자에 실 관리자 주소가 실제로 들어있다.
        hit_real_admin = [x for x in urgent if x.get('recipient') in admins]
        t.check('urgent 수신자에 실 관리자 주소 포함(구멍 존재 확인)', len(hit_real_admin) >= 1,
                '실관리자 수신 %d건' % len(hit_real_admin))

        # (2) 백스톱 개입: [테스트] 티켓의 모든 이메일 행이 is_test=true (싱크로 돌려졌음).
        #     백스톱이 없다면 urgent 행이 is_test=false로 실 관리자에게 갔을 것.
        not_test = [x for x in rows if x.get('is_test') is not True]
        t.check('[테스트] 티켓 이메일 전부 is_test=true(백스톱 개입)', len(not_test) == 0,
                '미표시=%s' % [(x.get('event_type'), x.get('recipient'), x.get('is_test')) for x in not_test])

        # 실 관리자 주소를 가리키는 행조차 is_test=true여야 한다(핵심 — 이게 false면 실 발송).
        t.check('실 관리자행도 is_test=true', all(x.get('is_test') is True for x in hit_real_admin),
                '%s' % [(x.get('recipient'), x.get('is_test')) for x in hit_real_admin])
    finally:
        if tid and len(dget('tickets', {'select': 'id', 'id': 'eq.' + tid}, role='admin').get('body') or []):
            wipe_ticket(tid)
        if uid: ddel('users', uid, role='admin')
        if co_id: ddel('companies', co_id, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
