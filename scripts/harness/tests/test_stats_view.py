"""L1 백엔드 계약 테스트 — 사용 통계(GET /stats/active-users) + stats_view 권한 연동.

실행: python scripts/harness/tests/test_stats_view.py
검증: admin 200(집계 구조) / 고객 403 / 권한관리 동적 토글(영업 OFF→403, ON→200).
role_permissions.stats_view(sales)를 잠시 토글하지만 종료 시 기본값(sales=false)으로 원복.
데이터 생성 없음(읽기 + 권한 토글만), 메일 트리거 없음.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import api, dget, dpatch, Checker


def run():
    t = Checker('L1 사용통계 권한(stats_view)')
    row = None
    try:
        # admin: 200 + 집계 구조
        ra = api('GET', '/stats/active-users', None, role='admin', userId='zz-admin')
        body = ra.get('body') or {}
        t.check('admin 조회 200', ra.get('status') == 200, 'status=%s' % ra.get('status'))
        t.check('집계 구조(dau/wau/mau/series)', all(k in body for k in ('dau', 'wau', 'mau', 'series')), 'keys=%s' % list(body)[:6])
        t.check('series 배열', isinstance(body.get('series'), list))

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
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
