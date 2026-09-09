# -*- coding: utf-8 -*-
"""하네스 자기 점검(린트) — 거짓통과·정리누락을 만드는 **패턴**이 새로 늘지 않게 막는다.

왜 이게 있나
-----------
감사를 할 때마다 "또 개선점"이 나왔는데, 세어보니 새 결함이 아니라 **같은 결함 클래스가
다시 발견된 것**이었다. 감사 T1이 2건, T2가 5건을 고쳤지만 같은 패턴의 모집단은 100건이
넘었다. 심지어 T2가 거짓통과를 막겠다며 넣은 양성대조 자체가 `len(docs) >= 0`(항상 참)
이었다 — 손으로 고치면 이렇게 된다.

그래서 개별 인스턴스를 쫓는 대신 **패턴을 기계가 세고, 늘어나면 실패**시킨다(래칫).
기존 위반은 baseline에 남겨두고 점진적으로 줄인다 — 100건을 한꺼번에 고치다 회귀를
깨뜨리는 것보다, 새 코드가 깨끗하고 숫자가 단조 감소하는 쪽이 안전하다.

AWS를 쓰지 않는다(순수 파일 검사). 그래서 자격증명·네트워크 없이 어디서나 돈다.

사용:
    python scripts/harness/tests/test_harness_lint.py
    python scripts/harness/tests/test_harness_lint.py --update-baseline   # 숫자 줄인 뒤 갱신
"""
import os, sys, re, json

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
from itest import Checker  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BASELINE = os.path.join(HERE, 'lint-baseline.json')
SELF = os.path.basename(__file__)

# 규칙: (키, 정규식, 사람이 읽는 설명, 대체 수단)
# 한 줄 단위로 센다. 예외가 정말 필요하면 그 줄 끝에 `# lint:allow-<키>` 를 단다.
RULES = [
    ('body_id',
     re.compile(r"\['body'\]\['id'\]"),
     "생성 응답에서 id를 직접 꺼냄 — 실패 시 KeyError로 죽어 정리도 리포트도 못 함",
     "must_id(resp) 또는 Fixtures.company()/user()/ticket()"),
    ('raw_all',
     re.compile(r"\.check\([^,]*,\s*all\("),
     "raw all() 단언 — 목록이 비면 공허하게 참(기능을 지워도 PASS)",
     "t.all_of(name, rows, pred, min_n=1)"),
    ('perm_patch',
     re.compile(r"dpatch\(\s*['\"]role_permissions['\"]"),
     "운영 권한을 직접 토글 — 하드코딩 값으로 복원하면 실제 설정을 덮어씀",
     "with permission(role, feature_key, enabled):"),
    ('loose_bool',
     re.compile(r"is not (?:False|True)\b"),
     "느슨한 불리언 비교 — null이 통과해 은닉/공개 판정이 새어나감",
     "is True / is False 로 엄격 비교"),
]


def scan():
    """tests/*.py를 훑어 규칙별·파일별 위반 위치를 모은다 → {규칙: {파일: [줄번호...]}}."""
    hits = {k: {} for k, _, _, _ in RULES}
    for fn in sorted(os.listdir(HERE)):
        if not fn.endswith('.py') or fn == SELF:
            continue
        with open(os.path.join(HERE, fn), encoding='utf-8') as f:
            for i, line in enumerate(f, 1):
                for key, rx, _, _ in RULES:
                    if rx.search(line) and ('# lint:allow-%s' % key) not in line:
                        hits[key].setdefault(fn, []).append(i)
    return hits


def counts(hits):
    """{규칙: {파일: 건수}} — baseline에 저장하는 형태. 줄번호는 편집마다 흔들리므로
    파일별 '건수'만 고정한다(어느 파일이 늘었는지는 정확히 짚으면서 잡음은 없게)."""
    return {k: {fn: len(v) for fn, v in files.items()} for k, files in hits.items()}


def grown(cur_files, base_files):
    """기준선 대비 늘어난 파일만 (파일, 현재, 기준) 목록으로."""
    out = []
    for fn in sorted(set(cur_files) | set(base_files)):
        c, b = cur_files.get(fn, 0), base_files.get(fn, 0)
        if c > b:
            out.append((fn, c, b))
    return out


def load_baseline():
    try:
        with open(BASELINE, encoding='utf-8') as f:
            return json.load(f)
    except OSError:
        return None


def run():
    t = Checker('하네스 린트 — 결함 패턴 래칫')
    hits = scan()
    base = load_baseline()

    if base is None:
        t.check('baseline 파일 존재', False,
                '%s 없음 — --update-baseline 로 생성할 것' % os.path.basename(BASELINE))
        return t.report()

    known = {k for k, _, _, _ in RULES}
    stale = [k for k in base if k not in known]
    t.check('baseline에 사라진 규칙 없음', not stale, '알 수 없는 키: %s' % stale)

    cur_counts = counts(hits)
    for key, _, why, fix in RULES:
        cur_files, base_files = cur_counts[key], base.get(key, {})
        cur, allowed = sum(cur_files.values()), sum(base_files.values())
        up = grown(cur_files, base_files)
        # 래칫: 어느 파일이든 늘면 실패, 같거나 줄면 통과. 총계가 같아도 한 파일이
        # 늘고 다른 파일이 줄었으면 새 위반이 들어온 것이므로 잡는다.
        detail = '현재 %d건 / 허용 %d건' % (cur, allowed)
        if up:
            detail += ' — 늘어남! %s → %s | ' % (why, fix) + ' · '.join(
                '%s %d→%d행 %s' % (fn, b, c, hits[key].get(fn, [])[-3:]) for fn, c, b in up)
        elif cur < allowed:
            detail += ' — 줄었음(개선). --update-baseline 로 기준선을 낮출 것'
        t.check('[%s] 위반 증가 없음' % key, not up, detail)

    total_cur = sum(sum(v.values()) for v in cur_counts.values())
    total_base = sum(sum(v.values()) for v in base.values() if isinstance(v, dict))
    print('\n── 잔여 부채: %d건 (기준선 %d건) ──' % (total_cur, total_base))
    for key, _, _, fix in RULES:
        n = sum(cur_counts[key].values())
        if n:
            print('  %-11s %3d건  %s' % (key, n, fix))
    return t.report()


def update_baseline():
    hits = scan()
    data = counts(hits)
    with open(BASELINE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')
    total = sum(sum(v.values()) for v in data.values())
    print('baseline 갱신 — 총 %d건' % total)
    for key, _, _, _ in RULES:
        n = sum(data[key].values())
        print('  %-11s %3d건  %s' % (key, n, ', '.join(
            '%s(%d)' % (fn, c) for fn, c in sorted(data[key].items()))))


if __name__ == '__main__':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    if '--update-baseline' in sys.argv:
        update_baseline()
        sys.exit(0)
    sys.exit(0 if run() else 1)
