# -*- coding: utf-8 -*-
"""promote.sh 검증 — main 전파가 ff-only인지, 남의 작업을 강제하지 않는지 본다 (R3).

왜 이 파일이 있나
----------------
예전 promote.sh는 $ROOT 아래에 Customer_portal / -dev / -design / -QA / -notion 이라는
형제 워크트리가 나란히 있다고 전제했다. 그 레이아웃은 이 레포에 없다(워크트리는
.claude/worktrees/ 아래에 생긴다). 그래서 **전 브랜치가 "워크트리 없음"으로 빠져
아무것도 전파하지 않으면서 성공처럼 끝났다** — 하는 일이 없는 줄 아무도 몰랐다.
게다가 전파 대상에 적혀 있던 QA는 원격에 존재한 적이 없다.

이제 원격 ref를 직접 ff push 하므로 워크트리가 필요 없다. 여기서 확인하는 것은
"실제로 전파가 일어나는가" + "일어나면 안 될 때 안 일어나는가" 두 가지다.

임시 git 레포(로컬 bare를 원격으로)에서 돌기 때문에 네트워크·AWS·운영 원격에 닿지 않는다.
"""
import os, sys, subprocess, tempfile, shutil

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
from itest import Checker, find_bash  # noqa: E402

HDIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
SCRIPT = os.path.join(HDIR, 'promote.sh')


def git(cwd, *args, check=True):
    p = subprocess.run(['git'] + list(args), cwd=cwd, capture_output=True,
                       text=True, encoding='utf-8', errors='replace')
    if check and p.returncode != 0:
        raise RuntimeError('git %s 실패: %s' % (' '.join(args), p.stderr.strip()))
    return (p.stdout or '').strip()


def commit(repo, msg, fname='f.txt'):
    with open(os.path.join(repo, fname), 'a', encoding='utf-8') as f:
        f.write(msg + '\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', msg)
    return git(repo, 'rev-parse', 'HEAD')


def build(lab):
    """원격(bare) + 클론을 만들고 네 가지 상태의 브랜치를 심는다."""
    origin = os.path.join(lab, 'origin.git')
    work = os.path.join(lab, 'work')
    subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', origin], check=True)
    subprocess.run(['git', 'clone', '-q', origin, work], check=True)
    git(work, 'config', 'user.email', 't@t.t')
    git(work, 'config', 'user.name', 'harness-test')

    base = commit(work, 'c1')
    mid = commit(work, 'c2')
    commit(work, 'c3')
    tip = git(work, 'rev-parse', 'HEAD')
    git(work, 'push', '-q', 'origin', 'main')

    # ① 이미 일치
    git(work, 'push', '-q', 'origin', 'main:refs/heads/synced')
    # ② main보다 뒤처짐(ff 가능) — c1 지점
    git(work, 'push', '-q', 'origin', base + ':refs/heads/behind')
    # ③ main보다 앞섬 — main + 고유 커밋
    git(work, 'checkout', '-q', '-b', 'ahead')
    commit(work, 'dev-only')
    git(work, 'push', '-q', 'origin', 'ahead')
    # ④ 갈라짐 — c2에서 갈라져 나온 다른 커밋
    git(work, 'checkout', '-q', '-b', 'diverged', mid)
    commit(work, 'other-line', 'g.txt')
    git(work, 'push', '-q', 'origin', 'diverged')
    git(work, 'checkout', '-q', 'main')
    return origin, work, tip, base


def run_promote(bash, work, targets, dry=False):
    env = dict(os.environ)
    env.update(PROMOTE_REPO=work, PROMOTE_REMOTE='origin',
               PROMOTE_TARGETS=targets, PYTHONIOENCODING='utf-8')
    cmd = [bash, SCRIPT] + (['--dry-run'] if dry else [])
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=env)
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def remote_sha(origin, branch):
    out = subprocess.run(['git', '--git-dir', origin, 'rev-parse', branch],
                         capture_output=True, text=True)
    return (out.stdout or '').strip() if out.returncode == 0 else None


def run():
    t = Checker('promote.sh — main 전파(ff-only)')
    bash = find_bash()
    if not bash:
        t.check('bash 사용 가능(하네스 전제)', False, 'PATH·git 설치 경로 어디에도 없음')
        return t.report()
    t.check('bash 사용 가능(하네스 전제)', True, bash)

    lab = tempfile.mkdtemp(prefix='promote_')
    try:
        origin, work, tip, base = build(lab)
        targets = 'synced behind ahead diverged missing'

        # ── dry-run: 아무것도 바꾸면 안 된다 ──
        before = {b: remote_sha(origin, b) for b in ('synced', 'behind', 'ahead', 'diverged')}
        rc, out = run_promote(bash, work, targets, dry=True)
        after = {b: remote_sha(origin, b) for b in before}
        t.check('--dry-run은 원격을 전혀 바꾸지 않음', before == after,
                '변화=%s' % {k: (before[k], after[k]) for k in before if before[k] != after[k]})
        t.check('--dry-run이 ff 가능 대상을 알려줌', 'behind' in out and 'ff 가능' in out,
                out.strip().splitlines()[-1] if out.strip() else '')

        # ── 실제 전파 ──
        rc, out = run_promote(bash, work, targets)

        t.check('뒤처진 브랜치를 main으로 ff 전파', remote_sha(origin, 'behind') == tip,
                'behind=%s / main=%s' % (remote_sha(origin, 'behind'), tip))
        t.check('앞선 브랜치는 건드리지 않음(개발 중인 dev 보호)',
                remote_sha(origin, 'ahead') == before['ahead'], remote_sha(origin, 'ahead'))
        t.check('갈라진 브랜치는 강제하지 않음',
                remote_sha(origin, 'diverged') == before['diverged'], remote_sha(origin, 'diverged'))
        t.check('이미 일치하는 브랜치는 그대로', remote_sha(origin, 'synced') == tip)
        t.check('원격에 없는 브랜치를 실패로 보고(조용히 넘기지 않음)',
                '원격' in out and 'missing' in out, 'missing 언급=%s' % ('missing' in out))
        t.check('갈라짐·부재가 있으면 종료코드 1', rc == 1, 'rc=%s' % rc)

        # ── 전부 정상일 때는 0 ──
        rc2, out2 = run_promote(bash, work, 'synced behind')
        t.check('전부 일치하면 종료코드 0', rc2 == 0, 'rc=%s' % rc2)

        # ── 양성대조: 강제 푸시가 아님을 실증 ──
        # ahead 브랜치를 대상으로 단독 실행해도 절대 뒤로 못 감(ff-only).
        rc3, _ = run_promote(bash, work, 'ahead')
        t.check('앞선 브랜치만 지정해도 되감기 없음 + rc=0',
                remote_sha(origin, 'ahead') == before['ahead'] and rc3 == 0,
                'sha유지=%s rc=%s' % (remote_sha(origin, 'ahead') == before['ahead'], rc3))
    finally:
        shutil.rmtree(lab, ignore_errors=True)

    return t.report(min_checks=10)


if __name__ == '__main__':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    sys.exit(0 if run() else 1)
