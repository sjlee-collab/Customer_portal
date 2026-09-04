"""L1 백엔드 계약 테스트 — 슬랙 알림 카테고리 팬아웃 + 답글 알림 조건.

실행: python scripts/harness/tests/test_notify_routing.py
검증 (notify-handler의 카테고리 라우팅 매트릭스):
  - 신규 등록(TICKET_INSERT): 공통 + 카테고리 채널
      other        → 공통만
      tech_support → 공통 + #기술지원-슬랙채널
      contract     → 공통 + #영업-슬랙채널
      education    → 공통 + #교육-슬랙채널
  - 영업(role=sales) 대리 등록: 카테고리와 무관하게 신규 등록·상태 변경·답글·담당자 배정이
    #영업-슬랙채널에도 (api-layer가 등록자 role을 조회해 registrarRole로 넘기고 notify-handler가 분기).
    상태 변경은 /status 단독 경로와 처리 모달(/manage) 두 경로 모두 확인한다.
  - 답글(TICKET_REPLY): 작성자가 customer일 때만 발송(공통 + 카테고리 채널),
    스태프 답글도 알림 (2026-09-02 14eb33f로 전 역할 확대 — 예전엔 고객만)
  - 등록 시 접수 확인 메일 1통(요청자에게)

판정은 log_notification.recipient(채널 표시명)로 한다 — '[테스트]' 라벨이라 실제 발송은
테스트 채널로 리다이렉트되지만 recipient에는 원래 대상 채널명이 남는다.
카테고리 채널 분기는 해당 웹훅 env(SLACK_WEBHOOK_SALES/TECH/EDU)가 설정된 환경 전제
(미설정이면 분기 자체를 건너뛰어 행이 안 남는다 — 운영 Lambda에는 설정돼 있음).

메일 주의: 등록은 실제 경로(POST /tickets)라 접수 확인 메일이 나간다. 요청자 주소가
temail() 싱크이므로 실행당 4통이 sjlee 싱크로 들어온다.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, api, wipe_ticket, notif_rows, wait_notif, tname, temail, Checker

COMMON = '#고객지원포탈-공통'
# 카테고리 → 등록/답글 알림이 추가로 가야 하는 채널 (notify-handler 라우팅 기준)
EXTRA = {
    'other':        set(),
    'tech_support': {'#기술지원-슬랙채널'},
    'contract':     {'#영업-슬랙채널'},
    'education':    {'#교육-슬랙채널'},
}


def run():
    t = Checker('L1 슬랙 라우팅(카테고리 팬아웃/답글)')
    created = {'companies': [], 'users': [], 'tickets': []}
    try:
        co = dpost('companies', {'name': tname('라우팅 회사'), 'status': 'active'})['body']['id']
        cu = dpost('users', {'email': temail('routeCust'), 'name': tname('라우팅고객'), 'role': 'customer',
                             'company_id': co, 'is_active': True})['body']['id']
        # 알림 게이트는 body의 role이 아니라 DB에서 조회한 작성자(role)로 판정하므로
        # 스태프 답글 검증에는 실제 스태프 계정이 필요하다.
        st = dpost('users', {'email': temail('routeStaff'), 'name': tname('라우팅직원'), 'role': 'internal',
                             'is_active': True})['body']['id']
        sa = dpost('users', {'email': temail('routeSales'), 'name': tname('라우팅영업'), 'role': 'sales',
                             'is_active': True})['body']['id']
        created['companies'].append(co); created['users'] += [cu, st, sa]
        C = dict(role='customer', userId=cu, companyId=co)

        # ── 신규 등록: 카테고리별 팬아웃 ──
        tids = {}
        for cat, extra in EXTRA.items():
            r = api('POST', '/tickets', {'title': tname('라우팅 ' + cat), 'category': cat,
                                         'description': '라우팅 테스트', 'priority': 'normal'}, **C)
            tid = (r.get('body') or {}).get('ticket', {}).get('id')
            t.check('[%s] 등록 201' % cat, r.get('status') == 201 and tid, 'status=%s' % r.get('status'))
            if not tid:
                continue
            tids[cat] = tid; created['tickets'].append(tid)

            expect = {COMMON} | extra
            slack = wait_notif(tid, 'slack', len(expect))
            got = {x.get('recipient') for x in slack if x.get('event_type') in ('new_ticket', 'urgent')}
            t.check('[%s] 등록 슬랙 채널 %s' % (cat, sorted(expect)), got == expect, '실제=%s' % sorted(got))

            mail = notif_rows(tid, 'email')
            t.check('[%s] 접수 확인 메일 1통' % cat, len(mail) == 1,
                    '실제=%d건 %s' % (len(mail), [m.get('event_type') for m in mail]))

        # ── 답글: 고객 답글만 알림, 카테고리 채널까지 팬아웃 ──
        tid = tids.get('tech_support')
        if tid:
            base = len(notif_rows(tid, 'slack'))
            r = api('POST', '/tickets/%s/reply' % tid, {'note': tname('고객 답글')}, **C)
            t.check('고객 답글 201', r.get('status') == 201, 'status=%s' % r.get('status'))
            slack = wait_notif(tid, 'slack', base + 2)
            reply_ch = {x.get('recipient') for x in slack if x.get('event_type') == 'reply'}
            t.check('고객 답글 슬랙: 공통+기술', reply_ch == {COMMON, '#기술지원-슬랙채널'},
                    '실제=%s' % sorted(reply_ch))

            # 스태프 답글도 알림 (2026-09-02 14eb33f로 확대 — 예전엔 고객 답글만 알림이 갔다.
            # 협업 담당자가 직원 답글을 놓치던 문제 해소. 채널 팬아웃은 고객 답글과 동일).
            n_before = len(notif_rows(tid, 'slack'))
            r = api('POST', '/tickets/%s/reply' % tid, {'note': tname('직원 답글')}, role='internal', userId=st)
            t.check('스태프 답글 201', r.get('status') == 201, 'status=%s' % r.get('status'))
            slack = wait_notif(tid, 'slack', n_before + 2)  # 공통 + 기술 채널 추가
            new_ch = {x.get('recipient') for x in slack if x.get('event_type') == 'reply'} - {COMMON, '#기술지원-슬랙채널'}
            t.check('스태프 답글도 알림(+2, 채널 동일)', len(slack) == n_before + 2 and not new_ch,
                    '이전=%d 이후=%d 예상외채널=%s' % (n_before, len(slack), sorted(new_ch)))
        # ── 영업이 대리 등록한 건: 카테고리(기술지원)와 무관하게 영업 채널에도 ──
        # 등록자 역할은 티켓에 저장하지 않고 발송 때마다 조회하므로, 대리등록자를 바꾸면
        # 그 뒤 알림부터 즉시 반영된다. 여기서는 등록 시점부터 영업으로 두고 확인한다.
        r = api('POST', '/tickets', {'title': tname('영업 대리등록'), 'category': 'tech_support',
                                     'description': '영업 대리 등록 라우팅', 'priority': 'normal',
                                     'on_behalf_of': cu}, role='sales', userId=sa)
        ptid = (r.get('body') or {}).get('ticket', {}).get('id')
        t.check('영업 대리 등록 201', r.get('status') == 201 and ptid, 'status=%s body=%s' % (r.get('status'), r.get('body')))
        if ptid:
            created['tickets'].append(ptid)
            slack = wait_notif(ptid, 'slack', 3)   # 공통 + 기술 + 영업
            got = {x.get('recipient') for x in slack if x.get('event_type') in ('new_ticket', 'urgent')}
            t.check('영업 대리등록 신규 슬랙: 공통+기술+영업',
                    got == {COMMON, '#기술지원-슬랙채널', '#영업-슬랙채널'}, '실제=%s' % sorted(got))

            base = len(notif_rows(ptid, 'slack'))
            r = api('PATCH', '/tickets/%s/status' % ptid, {'status': 'in_progress'}, role='admin')
            t.check('상태 변경 200', r.get('status') == 200, 'status=%s body=%s' % (r.get('status'), r.get('body')))
            slack = wait_notif(ptid, 'slack', base + 3)
            st_ch = {x.get('recipient') for x in slack if x.get('event_type') == 'status_change'}
            t.check('영업 대리등록 상태변경 슬랙: 공통+기술+영업',
                    st_ch == {COMMON, '#기술지원-슬랙채널', '#영업-슬랙채널'}, '실제=%s' % sorted(st_ch))

            # 답글 — 영업 대리등록 건이면 답글 알림도 영업 채널로
            base = len(notif_rows(ptid, 'slack'))
            r = api('POST', '/tickets/%s/reply' % ptid, {'note': tname('영업건 답글')}, **C)
            t.check('영업 대리등록 답글 201', r.get('status') == 201, 'status=%s' % r.get('status'))
            slack = wait_notif(ptid, 'slack', base + 3)
            rp_ch = {x.get('recipient') for x in slack if x.get('event_type') == 'reply'}
            t.check('영업 대리등록 답글 슬랙: 공통+기술+영업',
                    rp_ch == {COMMON, '#기술지원-슬랙채널', '#영업-슬랙채널'}, '실제=%s' % sorted(rp_ch))

            # 담당자 배정 + 상태 변경을 처리 모달(/manage) 한 번에 — 두 알림 모두 영업 채널 포함
            staff = (dget('users', {'select': 'id', 'role': 'eq.tech_support', 'is_active': 'eq.true',
                                    'limit': '1'}, role='admin').get('body') or [{}])[0].get('id')
            base = len(notif_rows(ptid, 'slack'))
            r = api('PATCH', '/tickets/%s/manage' % ptid,
                    {'category': 'tech_support', 'status': 'pending_customer', 'assigned_to': staff,
                     'due_date': None, 'memo': '', 'send_email': False}, role='admin')
            t.check('처리 모달 저장 200', r.get('status') == 200, 'status=%s' % r.get('status'))
            slack = wait_notif(ptid, 'slack', base + 6)   # 배정 3 + 상태 3
            asg_ch = {x.get('recipient') for x in slack if x.get('event_type') == 'assigned'}
            pend_ch = {x.get('recipient') for x in slack if x.get('event_type') == 'pending_customer'}
            t.check('영업 대리등록 배정 슬랙에 영업 포함', '#영업-슬랙채널' in asg_ch, '실제=%s' % sorted(asg_ch))
            t.check('처리 모달 상태변경도 공통+기술+영업',
                    pend_ch == {COMMON, '#기술지원-슬랙채널', '#영업-슬랙채널'}, '실제=%s' % sorted(pend_ch))

        # 고객 직접 등록(대리등록자 없음)은 영업 채널로 가지 않는다 — 규칙이 과하게 퍼지지 않는지 확인
        base_tid = tids.get('tech_support')
        if base_tid:
            ch = {x.get('recipient') for x in notif_rows(base_tid, 'slack')}
            t.check('고객 직접 등록 건은 영업 채널 없음', '#영업-슬랙채널' not in ch, '실제=%s' % sorted(ch))

    finally:
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for x in created['users']: ddel('users', x, role='admin')
        for x in created['companies']: ddel('companies', x, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
