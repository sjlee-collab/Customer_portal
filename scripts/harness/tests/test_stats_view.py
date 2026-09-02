"""L1 백엔드 계약 테스트 — 사용 통계(GET /stats/*) + stats_view 권한 연동.

실행: python scripts/harness/tests/test_stats_view.py
검증:
  - /stats/active-users, /stats/login-history: admin 200(집계 구조) / 고객 403
  - /stats/tickets: admin 200(KPI 구조) + 필터 파라미터 + 테스트 티켓이 집계에 반영 / 고객 403
  - /stats/companies, /stats/documents, /stats/company-detail: admin 200(구조) / 고객 403,
    company-detail은 id 누락 400
  - /stats/system, /stats/satisfaction (2026-09-01 추가 탭): admin 200(구조) / 고객 403
  - 권한관리 동적 토글(영업 OFF→403, ON→200)
role_permissions.stats_view(sales)를 잠시 토글하지만 종료 시 기본값(sales=false)으로 원복.
집계 반영 검증용 [테스트] 티켓 1개 생성 후 삭제(admin 직접 insert — 알림 없음).
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import api, dget, dpost, dpatch, ddel, wipe_ticket, tname, temail, Checker


def run():
    t = Checker('L1 사용통계 권한(stats_view)')
    row = None
    created = {'companies': [], 'users': [], 'tickets': []}
    try:
        # admin: 200 + 집계 구조
        ra = api('GET', '/stats/active-users', None, role='admin', userId='zz-admin')
        body = ra.get('body') or {}
        t.check('admin 조회 200', ra.get('status') == 200, 'status=%s' % ra.get('status'))
        t.check('집계 구조(dau/wau/mau/series)', all(k in body for k in ('dau', 'wau', 'mau', 'series')), 'keys=%s' % list(body)[:6])
        t.check('series 배열', isinstance(body.get('series'), list))
        t.check('확장 지표(totalLogins/byRole)', ('totalLogins' in body) and isinstance(body.get('byRole'), list), 'keys=%s' % sorted(body)[:8])

        # 고객: 403
        rc = api('GET', '/stats/active-users', None, role='customer', userId='zz-c', companyId='zz')
        t.check('고객 차단 403', rc.get('status') == 403, 'status=%s' % rc.get('status'))

        # 로그인 이력: admin 200 + 구조 / 고객 403
        lh = api('GET', '/stats/login-history', None, role='admin', userId='zz-admin')
        lb = lh.get('body') or {}
        t.check('로그인이력 admin 200', lh.get('status') == 200, 'status=%s' % lh.get('status'))
        t.check('로그인이력 구조(total/rows)', ('total' in lb) and isinstance(lb.get('rows'), list), 'keys=%s' % list(lb)[:5])
        lhc = api('GET', '/stats/login-history', None, role='customer', userId='zz-c', companyId='zz')
        t.check('로그인이력 고객 403', lhc.get('status') == 403, 'status=%s' % lhc.get('status'))

        # ── 요청 현황(/stats/tickets) — KPI 구조 + 필터 + 집계 반영 ──
        rt = api('GET', '/stats/tickets', None, role='admin', userId='zz-admin')
        tb = rt.get('body') or {}
        t.check('요청현황 admin 200', rt.get('status') == 200, 'status=%s' % rt.get('status'))
        t.check('요청현황 구조(summary/byStatus/aging/oldest)',
                isinstance(tb.get('summary'), dict) and all(k in tb for k in ('byStatus', 'aging', 'oldest')),
                'keys=%s' % sorted(tb)[:8])
        t.check('요청현황 KPI 키(total/open/unassigned/overdue/proxy)',
                all(k in (tb.get('summary') or {}) for k in ('total', 'open', 'unassigned', 'overdue', 'proxy')),
                'summary=%s' % sorted(tb.get('summary') or {}))
        rtc = api('GET', '/stats/tickets', None, role='customer', userId='zz-c', companyId='zz')
        t.check('요청현황 고객 403', rtc.get('status') == 403, 'status=%s' % rtc.get('status'))

        # 집계 반영: 미배정 open 테스트 티켓 1개를 넣으면 total/open/unassigned가 1씩 는다.
        # 공유 운영 백엔드라 스냅샷 사이에 남의 티켓이 생기거나 완료될 수 있다(실제 경합 관측:
        # 다른 세션이 미배정 open 건을 완료하면 total +1 / open +0이 됨) — 최대 3회 재시도로 흡수.
        co = dpost('companies', {'name': tname('통계 회사'), 'status': 'active'})['body']['id']
        cu = dpost('users', {'email': temail('statsCust'), 'name': tname('통계고객'), 'role': 'customer',
                             'company_id': co, 'is_active': True})['body']['id']
        created['companies'].append(co); created['users'].append(cu)
        tid = None
        for attempt in range(3):
            base = (api('GET', '/stats/tickets', None, role='admin', userId='zz-admin').get('body') or {}).get('summary') or {}
            new_tid = dpost('tickets', {'title': tname('통계 티켓%d' % attempt), 'category': 'other',
                                        'status': 'received', 'created_by': cu, 'company_id': co,
                                        'company_name': tname('통계 회사')}, role='admin')['body']['id']
            created['tickets'].append(new_tid); tid = new_tid
            after = (api('GET', '/stats/tickets', None, role='admin', userId='zz-admin').get('body') or {}).get('summary') or {}
            ok = all(after.get(k) == base.get(k, 0) + 1 for k in ('total', 'open', 'unassigned'))
            if ok: break
        t.check('집계 반영(total/open/unassigned +1, %d회차)' % (attempt + 1), ok,
                '전=%s 후=%s' % ({k: base.get(k) for k in ('total', 'open', 'unassigned')},
                                {k: after.get(k) for k in ('total', 'open', 'unassigned')}))
        # 필터 파라미터가 SQL로 먹히는지 — 미배정 필터는 unassigned와 같은 정의의 부분집합
        rf = api('GET', '/stats/tickets', None, role='admin', qs={'assignee': 'none', 'days': '7'}, userId='zz-admin')
        fs = (rf.get('body') or {}).get('summary') or {}
        t.check('필터(assignee=none&days=7) 200 + 정합', rf.get('status') == 200 and fs.get('total', -1) >= 1,
                'status=%s total=%s' % (rf.get('status'), fs.get('total')))

        # ── 고객 활용(/stats/companies) · 자료실(/stats/documents) · 상세(/stats/company-detail) ──
        rco = api('GET', '/stats/companies', None, role='admin', userId='zz-admin')
        cb = rco.get('body') or {}
        t.check('고객활용 admin 200 + 구조(rows/summary)', rco.get('status') == 200
                and isinstance(cb.get('rows'), list) and 'summary' in cb, 'keys=%s' % sorted(cb)[:6])
        t.check('고객활용 고객 403',
                api('GET', '/stats/companies', None, role='customer', userId='zz-c', companyId='zz').get('status') == 403)

        rdo = api('GET', '/stats/documents', None, role='admin', userId='zz-admin')
        db_ = rdo.get('body') or {}
        t.check('자료실 admin 200 + 구조(summary/top)', rdo.get('status') == 200
                and isinstance(db_.get('summary'), dict) and 'top' in db_, 'keys=%s' % sorted(db_)[:6])
        t.check('자료실 고객 403',
                api('GET', '/stats/documents', None, role='customer', userId='zz-c', companyId='zz').get('status') == 403)

        rcd = api('GET', '/stats/company-detail', None, role='admin', qs={'id': co}, userId='zz-admin')
        t.check('고객상세 admin 200', rcd.get('status') == 200, 'status=%s' % rcd.get('status'))
        t.check('고객상세 id 누락 400',
                api('GET', '/stats/company-detail', None, role='admin', userId='zz-admin').get('status') == 400)
        t.check('고객상세 고객 403',
                api('GET', '/stats/company-detail', None, qs={'id': co},
                    role='customer', userId='zz-c', companyId='zz').get('status') == 403)

        # ── 시스템 현황(/stats/system) · 응답 현황(/stats/satisfaction) — 2026-09-01 추가 탭 ──
        rsy = api('GET', '/stats/system', None, role='admin', userId='zz-admin')
        sb_ = rsy.get('body') or {}
        t.check('시스템현황 admin 200 + 구조(noti/byEvent)', rsy.get('status') == 200
                and 'noti' in sb_ and 'byEvent' in sb_, 'keys=%s' % sorted(sb_)[:6])
        t.check('시스템현황 고객 403',
                api('GET', '/stats/system', None, role='customer', userId='zz-c', companyId='zz').get('status') == 403)

        rsa = api('GET', '/stats/satisfaction', None, role='admin', userId='zz-admin')
        sat = rsa.get('body') or {}
        t.check('응답현황 admin 200 + 구조(summary/byRating)', rsa.get('status') == 200
                and isinstance(sat.get('summary'), dict) and 'byRating' in sat, 'keys=%s' % sorted(sat)[:6])
        t.check('응답현황 고객 403',
                api('GET', '/stats/satisfaction', None, role='customer', userId='zz-c', companyId='zz').get('status') == 403)

        # 권한 동적 토글: 영업 stats_view OFF→403, ON→200
        rows = dget('role_permissions', {'select': 'id,enabled', 'role': 'eq.sales', 'feature_key': 'eq.stats_view'}, role='admin').get('body') or []
        row = rows[0] if rows else None
        t.check('sales stats_view 시드행 존재', row is not None)
        if row:
            dpatch('role_permissions', row['id'], {'enabled': False}, role='admin')
            r1 = api('GET', '/stats/active-users', None, role='sales', userId='zz-s')
            t.check('권한OFF 영업 403', r1.get('status') == 403, 'status=%s' % r1.get('status'))
            dpatch('role_permissions', row['id'], {'enabled': True}, role='admin')
            r2 = api('GET', '/stats/active-users', None, role='sales', userId='zz-s')
            t.check('권한ON 영업 200', r2.get('status') == 200, 'status=%s' % r2.get('status'))
    finally:
        if row:  # 기본값(sales=false)으로 원복
            dpatch('role_permissions', row['id'], {'enabled': False}, role='admin')
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for x in created['users']: ddel('users', x, role='admin')
        for x in created['companies']: ddel('companies', x, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
