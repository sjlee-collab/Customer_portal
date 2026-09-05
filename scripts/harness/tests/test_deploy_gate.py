# -*- coding: utf-8 -*-
"""deploy-fn.sh 의 파괴적 drift 게이트 검증 — 진짜 스크립트를 그대로 돌린다.

왜 이 파일이 있나
----------------
예전 deploy-fn.sh는 drift를 출력만 하고 `sleep 3` 뒤 무조건 배포했다. 사람이 안 보는
호출(스크립트·세션)에선 게이트가 아예 없는 셈이었고, 2026-08-31에 배포본이 앞서 있어
재배포했으면 운영이 조용히 롤백될 뻔했다(DESIGN.md R4).

이제 diff의 '-' 줄(=배포본에만 있어 사라질 줄)이 0보다 크면 중단한다. 그런데 안전장치는
**막는지 확인하지 않으면 막는다고 믿을 뿐**이므로(T2 양성대조가 항상 참이었던 전례),
여기서 네 가지 상황을 실제로 돌려 확인한다.

운영 무접촉: aws.exe/curl을 스텁으로 갈아끼우고, LAMBDA_DIR로 가짜 소스를 물리고,
--dry-run으로 판정 직후 종료시킨다. 진짜 배포 호출이 일어나면 스텁이 exit 9로 실패시킨다.
전제는 Git Bash(README '전제' 항목과 동일).
"""
import os, sys, shutil, subprocess, tempfile, zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
from itest import Checker  # noqa: E402

HDIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
SCRIPT = os.path.join(HDIR, 'deploy-fn.sh')

AWS_STUB = """#!/usr/bin/env bash
case "$*" in
  *get-function*) echo "http://stub/deployed.zip" ;;
  *) echo "STUB: 실제 배포 호출됨($*)" >&2; exit 9 ;;
esac
"""
CURL_STUB = """#!/usr/bin/env bash
out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { out="$2"; shift; }; shift; done
cp "$STUB_DEPLOYED_ZIP" "$out"
"""


def find_bash():
    """PATH → SHELL → git.exe 설치 위치에서 유도. 회귀는 bash에서 실행돼 PATH에 있지만,
    PowerShell·IDE에서 단독 실행할 땐 없다. Git 설치 경로는 장비마다 다르므로
    (이 장비는 D:\\installed_program\\Git) 하드코딩하지 않고 git.exe 위치에서 찾는다."""
    p = shutil.which('bash') or os.environ.get('SHELL', '')
    if p and os.path.isfile(p):
        return p
    git = shutil.which('git')
    if git:
        root = os.path.dirname(os.path.dirname(git))          # …/Git/cmd/git.exe → …/Git
        for rel in (('bin', 'bash.exe'), ('usr', 'bin', 'bash.exe')):
            c = os.path.join(root, *rel)
            if os.path.isfile(c):
                return c
    return None


def _sh(path, body):
    """스텁 스크립트 생성.

    ⚠️ 파일명이 반드시 `.exe`여야 한다. Windows에서 os.chmod는 읽기전용 플래그만 건드리고
    **실행 비트를 못 준다.** 확장자 없는 `curl` 스텁은 Git Bash가 실행 불가로 보고 건너뛰어
    System32의 진짜 curl이 호출됐고, 그게 http://stub/... 을 해석 못 해 rc=6으로 죽었다
    (스텁이 안 먹은 줄 모르고 게이트가 깨진 줄 알기 딱 좋은 함정). Git Bash는 PATH 탐색 시
    `.exe`를 붙여 찾으므로, `curl.exe`로 두면 스크립트의 `curl` 호출이 이걸 집는다."""
    assert path.endswith('.exe'), '스텁은 .exe 이름이어야 Windows에서 실행된다: %s' % path
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)
    os.chmod(path, 0o755)


def _posix(bash, winpath):
    """Windows 경로 → POSIX(cygpath). PATH 항목은 POSIX여야 bash가 인식한다."""
    p = subprocess.run([bash, '-c', 'cygpath -u "$1"', '_', winpath],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    return (p.stdout or '').strip() or winpath


def _cmd(bash, stub_dir, args):
    """스텁 디렉터리를 PATH 맨 앞에 두고 deploy-fn.sh를 실행하는 명령을 만든다.

    ⚠️ 부모 프로세스에서 PATH를 앞에 붙여도 소용없다 — Git Bash는 기동할 때 자기
    /mingw64/bin 을 **PATH 맨 앞에 다시 붙인다**. 그래서 진짜 curl이 스텁보다 먼저 잡혀
    http://stub/... 를 해석 못 하고 rc=6으로 죽었다(스텁이 안 먹은 걸 게이트 결함으로
    오해하기 쉬운 함정). bash가 이미 뜬 뒤에 PATH를 다시 세워야 스텁이 이긴다."""
    return [bash, '-c', 'export PATH="$1:$PATH"; shift; exec bash "$@"', '_',
            _posix(bash, stub_dir), SCRIPT] + list(args)


def run_case(lab, bash, deployed, repo_src, extra=()):
    """(배포본 내용, 레포 내용)으로 --dry-run 실행 → (종료코드, 출력)."""
    src = os.path.join(lab, 'lambda', 'data-api')
    shutil.rmtree(os.path.join(lab, 'lambda'), ignore_errors=True)
    os.makedirs(src)
    with open(os.path.join(src, 'index.mjs'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(repo_src)
    dep = os.path.join(lab, 'dep.mjs')
    with open(dep, 'w', encoding='utf-8', newline='\n') as f:
        f.write(deployed)
    zp = os.path.join(lab, 'deployed.zip')
    with zipfile.ZipFile(zp, 'w') as z:
        z.write(dep, 'index.mjs')

    env = dict(os.environ)
    env['LAMBDA_DIR'] = os.path.join(lab, 'lambda')
    env['STUB_DEPLOYED_ZIP'] = zp
    env['DEPLOY_BACKUP_DIR'] = os.path.join(lab, 'backup')
    env['PYTHONIOENCODING'] = 'utf-8'
    p = subprocess.run(_cmd(bash, os.path.join(lab, 'bin'), ['data-api', '--dry-run'] + list(extra)),
                       capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def run():
    t = Checker('deploy-fn 파괴적 drift 게이트')
    bash = find_bash()
    # Git Bash는 하네스의 명시적 전제다 — 없으면 조용히 skip하지 않고 실패시킨다
    # (skip이 초록으로 보고되던 게 거짓통과의 한 축이었다).
    if not bash:
        t.check('bash 사용 가능(하네스 전제)', False, 'PATH에 bash 없음 — Git Bash 필요')
        return t.report()
    t.check('bash 사용 가능(하네스 전제)', True, bash)

    lab = tempfile.mkdtemp(prefix='deploygate_')
    try:
        os.makedirs(os.path.join(lab, 'bin'))
        _sh(os.path.join(lab, 'bin', 'aws.exe'), AWS_STUB)
        _sh(os.path.join(lab, 'bin', 'curl.exe'), CURL_STUB)

        base = 'a\nb\nc\n'
        cases = [
            ('배포본 == 레포 → 통과', base, base, (), 0, '사라지는 운영 코드 없음'),
            ('순수 추가(레포가 앞섬) → 통과', base, base + 'd\n', (), 0, '사라지는 운영 코드 없음'),
            ('배포본에만 있는 줄 → 차단', base + 'HOTFIX\n', base, (), 3, '파괴적 drift'),
            ('치환도 삭제로 계산 → 차단', base, 'a\nB\nc\n', (), 3, '운영 코드 1줄 사라짐'),
            ('--force면 경고 후 진행', base + 'HOTFIX\n', base, ('--force',), 0, 'force 지정'),
        ]
        for name, dep, rep, extra, want_rc, needle in cases:
            rc, out = run_case(lab, bash, dep, rep, extra)
            t.check(name, rc == want_rc and needle in out,
                    'rc=%s(기대 %s) / 문구=%s' % (rc, want_rc, needle in out))

        # 게이트를 통과시킨 뒤(배포본==레포라 LOST=0) --dry-run 없이 배포 단계까지 보낸다.
        # 기대: 배포 직전에 백업을 남기고, update-function-code에서 스텁이 exit 9로 막는다.
        # (배포본 zip을 이 케이스용으로 새로 만들어야 한다 — 앞 케이스 것을 재사용하면
        #  게이트에 걸려 rc=3이 나고, 그러면 '스텁이 막았다'가 아니라 게이트가 막은 것이다.)
        src = os.path.join(lab, 'lambda', 'data-api')
        shutil.rmtree(os.path.join(lab, 'lambda'), ignore_errors=True); os.makedirs(src)
        with open(os.path.join(src, 'index.mjs'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(base)
        dep = os.path.join(lab, 'dep.mjs')
        with open(dep, 'w', encoding='utf-8', newline='\n') as f:
            f.write(base)
        with zipfile.ZipFile(os.path.join(lab, 'deployed.zip'), 'w') as z:
            z.write(dep, 'index.mjs')
        env = dict(os.environ)
        env.update(LAMBDA_DIR=os.path.join(lab, 'lambda'), STUB_DEPLOYED_ZIP=os.path.join(lab, 'deployed.zip'),
                   DEPLOY_BACKUP_DIR=os.path.join(lab, 'backup'), PYTHONIOENCODING='utf-8')
        p = subprocess.run(_cmd(bash, os.path.join(lab, 'bin'), ['data-api']), capture_output=True,
                           text=True, encoding='utf-8', errors='replace', env=env)
        out = (p.stdout or '') + (p.stderr or '')
        t.check('게이트 통과 후 실제 배포 호출까지 진행하고, 스텁이 그걸 가로챔(운영 무접촉)',
                p.returncode != 0 and 'STUB: 실제 배포 호출됨' in out,
                'rc=%s / 스텁차단=%s' % (p.returncode, 'STUB: 실제 배포 호출됨' in out))
        t.check('배포 직전 롤백용 백업을 남김',
                os.path.isdir(env['DEPLOY_BACKUP_DIR']) and
                any(f.startswith('data-api-') for f in os.listdir(env['DEPLOY_BACKUP_DIR'])),
                '백업 디렉터리=%s' % env['DEPLOY_BACKUP_DIR'])
    finally:
        shutil.rmtree(lab, ignore_errors=True)

    return t.report(min_checks=8)


if __name__ == '__main__':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    sys.exit(0 if run() else 1)
