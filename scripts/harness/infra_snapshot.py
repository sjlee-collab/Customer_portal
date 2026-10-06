# -*- coding: utf-8 -*-
"""인프라 구성 스냅샷 — 콘솔에만 있는 설정을 레포에 글로 남긴다.

왜 필요한가
-----------
이 인프라에는 CloudFormation 스택이 없다(전부 콘솔·CLI 수작업). Lambda 소스와
schema.sql은 레포에 있지만, **설정**은 AWS 콘솔 화면이 유일한 기록이다:
Lambda 환경변수, API Gateway 라우트·통합, Amplify 리라이트(고객사 접속에 직결),
EventBridge 스케줄, S3 버킷 정책. 이것들이 사라지면 "원래 뭐였는지"를 알 길이 없다.

이 스크립트는 그 설정을 JSON으로 떠서 infra/snapshot/ 아래에 둔다. 복원을 자동화하지는
않는다 — 대신 **무엇이었는지**가 git에 남고, 누가 콘솔에서 뭘 바꾸면 diff에 드러난다.

비밀은 담지 않는다
------------------
환경변수·시크릿 값은 쓰지 않는다. 키 이름이 민감 패턴(SECRET/KEY/TOKEN/WEBHOOK…)에
걸리면 값 대신 sha256 앞 12자와 길이만 남긴다. 값이 바뀐 것은 감지되지만 값 자체는
레포에 들어가지 않는다.

diff가 의미 있게
----------------
배포·조회 때마다 달라지는 필드(LastModified·CodeSha256·RevisionId 등)는 버린다.
남은 차이는 "사람이 설정을 바꿨다"는 뜻이다. 키는 정렬해 저장한다.

사용:
  python scripts/harness/infra_snapshot.py            # 스냅샷 갱신
  python scripts/harness/infra_snapshot.py --check    # 갱신 후 변경이 있으면 종료코드 1
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

# 윈도우 콘솔 기본값(cp949)으로는 체크표·화살표가 그대로 예외를 낸다 — 출력만 UTF-8로 고정한다.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

REGION = os.environ.get('AWS_REGION', 'ap-northeast-2')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUTDIR = os.path.join(ROOT, 'infra', 'snapshot')
KST = timezone(timedelta(hours=9))

# 이 계정에서 이 프로젝트가 쓰는 리소스만 고른다(계정에 다른 것이 생겨도 스냅샷이 흔들리지 않게).
NAME_HINT = re.compile(r'(customer[_-]portal|bigxdata)', re.I)

# 값이 민감한 키 — 값 대신 지문만 남긴다.
# 비밀이 들어갈 수 있는 자리는 사실상 Lambda 환경변수뿐이다(비밀값은 Secrets Manager로
# 이관돼 있고, 환경변수에는 그 '주소'만 남아 있다). 그래서 키 이름 검사는 환경변수 아래로
# 한정한다 — 전역에 걸면 RouteKey·ApiKeyRequired 같은 복원에 꼭 필요한 값까지 가려진다.
ENV_PATH = re.compile(r'\.Environment\.Variables\.')
SECRET_KEY = re.compile(r'(SECRET|KEY|TOKEN|PASSWORD|PASSWD|_PW|WEBHOOK|WEEBHOOK|CREDENTIAL|SIGNING|SALT)', re.I)
# 시크릿을 가리키는 이름/ARN은 비밀이 아니고 복원에 필요하다(예: DB_SECRET_ID).
ID_LIKE = re.compile(r'(_ID|_NAME|_ARN|_FN)$', re.I)
# 값이 '시크릿 보관함 주소' 형태면 키 이름과 무관하게 비밀이 아니다 — dev는 SECRET_JWT 처럼
# 접미사 없이 이름만 담는 변수를 쓴다. 이걸 가리면 어느 시크릿을 보는지 알 수 없어진다.
SECRET_PATH_VALUE = re.compile(r'^(customer-portal/|rds!)')
# 키 이름과 무관하게, 값 자체가 비밀 형태면 어디에 있든 가린다(마지막 안전망).
VALUE_SECRET = re.compile(r'(hooks\.slack\.com/services/|AKIA[0-9A-Z]{16}|-----BEGIN |xox[baprs]-|eyJ[A-Za-z0-9_-]{20,}\.)')

# 볼 때마다 달라져 diff를 더럽히는 필드 — 설정이 아니라 상태/시각이다.
VOLATILE = {
    'LastModified', 'LastModifiedTime', 'LastUpdatedAt', 'CreationDate', 'CreatedAt', 'CreateDate',
    'UpdateTime', 'CreationTime', 'InstanceCreateTime', 'LatestRestorableTime', 'LastRotatedDate',
    'LastChangedDate', 'LastAccessedDate', 'NextInvocations', 'RevisionId', 'CodeSha256', 'CodeSize',
    'ResponseMetadata', 'NextToken', 'nextToken', 'createTime', 'updateTime', 'createTimeInMillis',
    'updateTimeInMillis', 'lastDeployTime', 'totalNumberOfJobs', 'jobArn', 'CodeSigningConfigArn',
    'MasterUserSecret', 'Endpoint.HostedZoneId', 'StatusInfos', 'PendingModifiedValues',
    'webhookCreateTime', 'webhookUpdateTime', 'LastDeploymentStatusMessage',
    # 역할이 '마지막으로 쓰인 시각'은 설정이 아니라 사용 흔적이라 돌릴 때마다 바뀐다.
    'RoleLastUsed',
}

errors = []
counts = {}


def aws(service, op, *args, allow_fail=False):
    """AWS CLI 한 번 호출. 실패는 기록만 하고 None을 돌려줘 나머지 수집을 계속한다."""
    cmd = ['aws', service, op, '--region', REGION, '--output', 'json', *args]
    # AWS CLI도 파이썬이라, 윈도우 콘솔 기본 인코딩(cp949)으로 출력하려다 한글·em-dash에서
    # 깨진다. PYTHONUTF8로 CLI 쪽 출력을 UTF-8로 고정한다.
    env = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1', AWS_PAGER='')
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', env=env, timeout=120)
    except Exception as e:                                    # noqa: BLE001 — 수집은 계속되어야 한다
        if not allow_fail:
            errors.append({'cmd': f'{service} {op}', 'error': str(e)[:200]})
        return None
    if p.returncode != 0:
        msg = (p.stderr or '').strip().splitlines()[-1] if p.stderr else f'exit {p.returncode}'
        if not allow_fail:
            errors.append({'cmd': f'{service} {op} {" ".join(args)}'.strip(), 'error': msg[:300]})
        return None
    try:
        return json.loads(p.stdout or 'null')
    except json.JSONDecodeError:
        return p.stdout.strip() or None


def fingerprint(value):
    """값 대신 남기는 지문 — 바뀌면 diff에 드러나지만 값은 복원되지 않는다."""
    s = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    return {'__sha256_12': hashlib.sha256(s.encode('utf-8')).hexdigest()[:12], '__len': len(s)}


def clean(node, path=''):
    """변동 필드를 버리고 민감값은 지문으로 바꾼다."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            here = f'{path}.{k}' if path else k
            if k in VOLATILE or here in VOLATILE:
                continue
            by_name = (ENV_PATH.search(here) and SECRET_KEY.search(k)
                       and not ID_LIKE.search(k) and v not in (None, '', [], {})
                       and not (isinstance(v, str) and SECRET_PATH_VALUE.match(v)))
            by_value = isinstance(v, str) and VALUE_SECRET.search(v)
            out[k] = fingerprint(v) if (by_name or by_value) else clean(v, here)
        return out
    if isinstance(node, list):
        return [clean(x, path) for x in node]
    return node


def write(name, data):
    os.makedirs(OUTDIR, exist_ok=True)
    path = os.path.join(OUTDIR, name)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(clean(data), f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')
    n = len(data) if isinstance(data, (list, dict)) else 1
    counts[name] = n
    print(f'  {name:<18} {n}')


# ── Lambda ── 소스는 레포에 있지만 환경변수·메모리·VPC·역할은 여기에만 있다
def snap_lambda():
    names = []
    d = aws('lambda', 'list-functions')
    for f in (d or {}).get('Functions', []):
        if NAME_HINT.search(f.get('FunctionName', '')):
            names.append(f['FunctionName'])
    out = {}
    for n in sorted(names):
        cfg = aws('lambda', 'get-function-configuration', '--function-name', n)
        if not cfg:
            continue
        # 동시성·트리거는 구성과 별개 API라 따로 붙인다(복원 시 빠뜨리기 쉬운 항목).
        conc = aws('lambda', 'get-function-concurrency', '--function-name', n, allow_fail=True)
        policy = aws('lambda', 'get-policy', '--function-name', n, allow_fail=True)
        cfg['_reservedConcurrency'] = (conc or {}).get('ReservedConcurrentExecutions')
        if policy and policy.get('Policy'):
            try:
                cfg['_resourcePolicy'] = json.loads(policy['Policy'])
            except json.JSONDecodeError:
                pass
        out[n] = cfg
    write('lambda.json', out)


# ── API Gateway(HTTP API) ── 어느 경로가 어느 Lambda로 가는지가 콘솔에만 있다
def snap_apigw():
    apis = (aws('apigatewayv2', 'get-apis') or {}).get('Items', [])
    out = {}
    for a in apis:
        aid = a['ApiId']
        entry = {'api': a}
        for key, op in (('routes', 'get-routes'), ('integrations', 'get-integrations'),
                        ('authorizers', 'get-authorizers'), ('stages', 'get-stages')):
            r = aws('apigatewayv2', op, '--api-id', aid)
            entry[key] = (r or {}).get('Items', [])
        # 라우트는 순서가 들쭉날쭉이라 정렬해야 diff가 조용하다.
        entry['routes'].sort(key=lambda x: x.get('RouteKey', ''))
        entry['integrations'].sort(key=lambda x: x.get('IntegrationId', ''))
        out[aid] = entry
    write('apigateway.json', out)


# ── EventBridge Scheduler ── 매일 09:00 KST 배치 3종
def snap_scheduler():
    items = (aws('scheduler', 'list-schedules') or {}).get('Schedules', [])
    out = {}
    for s in sorted(items, key=lambda x: x.get('Name', '')):
        d = aws('scheduler', 'get-schedule', '--name', s['Name'],
                *(['--group-name', s['GroupName']] if s.get('GroupName') else []))
        if d:
            out[s['Name']] = d
    write('scheduler.json', out)


# ── Amplify ── 리라이트 규칙은 특정 고객사의 접속 가능 여부에 직결된다
def snap_amplify():
    apps = (aws('amplify', 'list-apps') or {}).get('apps', [])
    out = {}
    for a in apps:
        aid = a['appId']
        entry = {'app': a}
        br = aws('amplify', 'list-branches', '--app-id', aid, allow_fail=True)
        entry['branches'] = [
            {k: v for k, v in b.items() if k in
             ('branchName', 'stage', 'enableAutoBuild', 'enablePullRequestPreview',
              'framework', 'environmentVariables', 'ttl', 'enableBasicAuth')}
            for b in (br or {}).get('branches', [])
        ]
        entry['branches'].sort(key=lambda x: x.get('branchName', ''))
        dom = aws('amplify', 'list-domain-associations', '--app-id', aid, allow_fail=True)
        entry['domains'] = (dom or {}).get('domainAssociations', [])
        out[aid] = entry
    write('amplify.json', out)


# ── S3 ── 버킷 자체보다 정책·CORS·버저닝이 복원하기 까다롭다
def snap_s3():
    buckets = [b['Name'] for b in (aws('s3api', 'list-buckets') or {}).get('Buckets', [])
               if NAME_HINT.search(b['Name'])]
    out = {}
    for b in sorted(buckets):
        e = {}
        pol = aws('s3api', 'get-bucket-policy', '--bucket', b, allow_fail=True)
        if pol and pol.get('Policy'):
            try:
                e['policy'] = json.loads(pol['Policy'])
            except json.JSONDecodeError:
                e['policy'] = pol['Policy']
        for key, op in (('cors', 'get-bucket-cors'), ('versioning', 'get-bucket-versioning'),
                        ('lifecycle', 'get-bucket-lifecycle-configuration'),
                        ('publicAccessBlock', 'get-public-access-block'),
                        ('encryption', 'get-bucket-encryption')):
            # 설정이 없으면 CLI가 에러를 내는 게 정상이라 실패를 기록하지 않는다.
            r = aws('s3api', op, '--bucket', b, allow_fail=True)
            if r:
                e[key] = r
        out[b] = e
    write('s3.json', out)


# ── Secrets Manager ── 이름과 메타만. 값은 가져오지 않는다.
def snap_secrets():
    items = (aws('secretsmanager', 'list-secrets') or {}).get('SecretList', [])
    out = {}
    for s in sorted(items, key=lambda x: x.get('Name', '')):
        out[s['Name']] = {k: v for k, v in s.items()
                          if k in ('ARN', 'Description', 'RotationEnabled', 'KmsKeyId', 'Tags')}
    write('secrets.json', out)


# ── RDS ── 인스턴스 설정 + 기본값에서 바꾼 파라미터만
def snap_rds():
    inst = (aws('rds', 'describe-db-instances') or {}).get('DBInstances', [])
    out = {'instances': {}, 'parameterGroups': {}}
    groups = set()
    for i in inst:
        out['instances'][i['DBInstanceIdentifier']] = i
        for g in i.get('DBParameterGroups', []):
            groups.add(g['DBParameterGroupName'])
    for g in sorted(groups):
        # source=user — 기본값 그대로인 수백 개는 빼고 '우리가 바꾼 것'만 남긴다.
        p = aws('rds', 'describe-db-parameters', '--db-parameter-group-name', g,
                '--source', 'user', allow_fail=True)
        out['parameterGroups'][g] = [
            {k: v for k, v in x.items() if k in ('ParameterName', 'ParameterValue', 'ApplyMethod')}
            for x in (p or {}).get('Parameters', [])
        ]
    write('rds.json', out)


# ── 네트워크 ── Lambda·RDS가 실제로 쓰는 SG와 서브넷만
def snap_network():
    used_sg, used_subnet = set(), set()
    lam = aws('lambda', 'list-functions')
    for f in (lam or {}).get('Functions', []):
        if not NAME_HINT.search(f.get('FunctionName', '')):
            continue
        v = f.get('VpcConfig') or {}
        used_sg.update(v.get('SecurityGroupIds') or [])
        used_subnet.update(v.get('SubnetIds') or [])
    for i in (aws('rds', 'describe-db-instances') or {}).get('DBInstances', []):
        used_sg.update(g['VpcSecurityGroupId'] for g in i.get('VpcSecurityGroups', []))
        used_subnet.update(s['SubnetIdentifier'] for s in (i.get('DBSubnetGroup') or {}).get('Subnets', []))

    out = {'securityGroups': {}, 'subnets': {}}
    if used_sg:
        sgs = aws('ec2', 'describe-security-groups', '--group-ids', *sorted(used_sg), allow_fail=True)
        for g in (sgs or {}).get('SecurityGroups', []):
            out['securityGroups'][g['GroupId']] = {
                'GroupName': g.get('GroupName'), 'Description': g.get('Description'),
                'VpcId': g.get('VpcId'),
                'IpPermissions': g.get('IpPermissions'),
                'IpPermissionsEgress': g.get('IpPermissionsEgress'),
            }
    if used_subnet:
        sn = aws('ec2', 'describe-subnets', '--subnet-ids', *sorted(used_subnet), allow_fail=True)
        for s in (sn or {}).get('Subnets', []):
            out['subnets'][s['SubnetId']] = {
                'VpcId': s.get('VpcId'), 'CidrBlock': s.get('CidrBlock'),
                'AvailabilityZone': s.get('AvailabilityZone'),
                'MapPublicIpOnLaunch': s.get('MapPublicIpOnLaunch'),
            }
    write('network.json', out)


# ── IAM ── 지금 자격증명에는 읽기 권한이 없다. 권한이 생기면 자동으로 채워진다.
def snap_iam():
    roles = set()
    for f in (aws('lambda', 'list-functions') or {}).get('Functions', []):
        if NAME_HINT.search(f.get('FunctionName', '')) and f.get('Role'):
            roles.add(f['Role'].rsplit('/', 1)[-1])
    out, denied = {}, False
    for r in sorted(roles):
        d = aws('iam', 'get-role', '--role-name', r, allow_fail=True)
        if not d:
            denied = True
            continue
        entry = {'role': d.get('Role')}
        att = aws('iam', 'list-attached-role-policies', '--role-name', r, allow_fail=True)
        entry['attached'] = (att or {}).get('AttachedPolicies', [])
        inl = aws('iam', 'list-role-policies', '--role-name', r, allow_fail=True)
        entry['inline'] = {}
        for pn in (inl or {}).get('PolicyNames', []):
            pd = aws('iam', 'get-role-policy', '--role-name', r, '--policy-name', pn, allow_fail=True)
            if pd:
                entry['inline'][pn] = pd.get('PolicyDocument')
        out[r] = entry
    if denied:
        out['_note'] = ('이 자격증명(customer_portal)에 iam:Get*/List* 권한이 없어 역할 내용을 '
                        '담지 못했다. 권한을 붙이면 다음 실행부터 자동으로 채워진다. '
                        '역할 이름은 lambda.json의 Role ARN에 남아 있다.')
    write('iam.json', out)


def main():
    check = '--check' in sys.argv
    print(f'── 인프라 구성 스냅샷 ({REGION}) ──')
    ident = aws('sts', 'get-caller-identity')
    if not ident:
        print('❌ AWS 자격증명을 쓸 수 없습니다. AWS_PROFILE을 확인하세요.')
        return 2

    for fn in (snap_lambda, snap_apigw, snap_scheduler, snap_amplify,
               snap_s3, snap_secrets, snap_rds, snap_network, snap_iam):
        try:
            fn()
        except Exception as e:                                # noqa: BLE001 — 한 항목 실패로 전체를 버리지 않는다
            errors.append({'cmd': fn.__name__, 'error': str(e)[:300]})
            print(f'  ⚠ {fn.__name__} 실패: {str(e)[:120]}')

    meta = {
        'takenAt': datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S %z'),
        'account': ident.get('Account'),
        'region': REGION,
        'counts': counts,
        'errors': errors,
        'note': '설정만 담는다. 비밀 값은 담지 않으며 민감 키는 sha256 지문으로 대체한다.',
    }
    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, '_meta.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')

    if errors:
        print(f'\n⚠ 수집 실패 {len(errors)}건 — _meta.json의 errors 참고')
        for e in errors[:5]:
            print(f'   · {e["cmd"]}: {e["error"][:110]}')

    if check:
        # _meta.json은 실행 시각 때문에 항상 바뀐다 — 변경 판정에서 뺀다.
        p = subprocess.run(['git', 'diff', '--stat', '--', 'infra/snapshot', ':!infra/snapshot/_meta.json'],
                           cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
        changed = (p.stdout or '').strip()
        if changed:
            print('\n⚠ 지난 스냅샷과 달라진 설정이 있습니다 — 의도한 변경인지 확인하세요.')
            print(changed)
            return 1
        print('\n✅ 설정 변화 없음')
    else:
        print('\n✅ 스냅샷 갱신 완료 — infra/snapshot/')
    return 0


if __name__ == '__main__':
    sys.exit(main())
