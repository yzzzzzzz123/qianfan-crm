"""Freeze application-only code and optionally compare the running server, read-only.

This is deliberately not a deployment or database migration command.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import tarfile

SKILL = Path(__file__).resolve().parents[1]
PROJECT_ROOT = SKILL.parents[1]
PROFILE = json.loads((SKILL / 'profile.json').read_text(encoding='utf-8'))


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def safe_name(name):
    parts = PurePosixPath(name).parts
    forbidden = {'data', '.data', '.private', 'runtime', 'node_modules', 'backups',
                 'uploads', 'logs', '.git', '__pycache__', '.env'}
    if (not parts or name.startswith('/') or '\\' in name or
            any(part in {'.', '..'} or part.lower() in forbidden for part in parts) or
            any(part.lower().startswith('.env.') for part in parts) or
            name.lower().endswith(('.sqlite', '.sqlite3', '.db', '.pem', '.key', '.pyc'))):
        raise ValueError('Protected or unsafe source path: ' + name)
    return name


def source_files():
    if PROJECT_ROOT.name != PROFILE['project']:
        raise RuntimeError('Project folder does not match this skill profile')
    source = (PROJECT_ROOT / PROFILE['source']).resolve()
    if not source.is_relative_to(PROJECT_ROOT):
        raise RuntimeError('Source must stay inside this project')
    result = {}
    for folder, target in PROFILE['folders'].items():
        directory = source / folder
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError('Required source folder missing or linked: ' + folder)
        for parent, directories, names in os.walk(directory, followlinks=False):
            for name in directories + names:
                if (Path(parent) / name).is_symlink():
                    raise RuntimeError('Source links cannot enter the package')
            for name in names:
                path = Path(parent) / name
                relative = safe_name((PurePosixPath(target) / path.relative_to(directory).as_posix()).as_posix())
                if not path.is_file() or relative in result:
                    raise RuntimeError('Non-regular or duplicate source: ' + relative)
                result[relative] = path
    for name in PROFILE['files']:
        path = source / safe_name(name)
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('Required source file missing or linked: ' + name)
        if path.resolve() != path.absolute():
            raise RuntimeError('Linked parent in source path')
        result[name] = path
    if PROFILE['project'] == 'sparnow-crm':
        build = json.loads((source / 'dist-server/build-manifest.json').read_text(encoding='utf-8'))
        if build.get('base') != PROFILE['basePath']:
            raise RuntimeError('Server build base must be /sparnow-crm/')
        current = {}
        for folder in ['src', 'public']:
            for parent, directories, names in os.walk(source / folder, followlinks=False):
                for name in directories + names:
                    if (Path(parent) / name).is_symlink():
                        raise RuntimeError('Frontend source must not contain links')
                for name in names:
                    path = Path(parent) / name
                    current[path.relative_to(source).as_posix()] = sha(path)
        for name in ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json']:
            current[name] = sha(source / name)
        if build.get('files') != current:
            raise RuntimeError('Server build is stale; rebuild from the current local frontend')
    return dict(sorted(result.items()))


def connect():
    import paramiko
    profile = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'CodexPrivate/BaotaServer/credentials.md'
    body = profile.read_text(encoding='utf-8-sig')

    def field(label):
        match = re.search(r'(?im)^[\s|*-]*' + re.escape(label) + r'\s*[:：|]\s*(.+)$', body)
        if not match:
            raise RuntimeError('Private SSH profile is missing a required field')
        value = match.group(1).strip()
        if match.group(0).lstrip().startswith('|'):
            value = value.rstrip('|').strip()
        return value[1:-1] if value.startswith('`') and value.endswith('`') else value

    if field('IP') != PROFILE['host']:
        raise RuntimeError('Private SSH target mismatch')
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(PROFILE['host'], port=int(field('SSH 端口')), username=field('SSH 用户名'),
                   password=field('SSH 密码'), look_for_keys=False, allow_agent=False,
                   timeout=15, auth_timeout=20, banner_timeout=15)
    return client


def compare(local_manifest):
    """Remote probe hashes only local/previously manifested code, never business data."""
    remote_profile = {key: PROFILE[key] for key in ['service', 'rootfs', 'releaseRoot', 'folders', 'files']}
    if 'currentLink' in PROFILE:
        remote_profile['currentLink'] = PROFILE['currentLink']
    probe = r'''
import hashlib,json,subprocess
from pathlib import Path,PurePosixPath
p=PROFILE
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for block in iter(lambda:f.read(1048576),b''):h.update(block)
 return h.hexdigest()
def allowed(name):
 parts=PurePosixPath(name).parts
 blocked={'data','.data','.private','runtime','node_modules','backups','uploads','logs','.git','__pycache__','.env'}
 if not parts or name.startswith('/') or '\\' in name or any(x in {'.','..'} or x.lower() in blocked or x.lower().startswith('.env.') for x in parts):return False
 if name.lower().endswith(('.sqlite','.sqlite3','.db','.pem','.key','.pyc')):return False
 return name in p['files'] or any(name.startswith(t+'/') for t in p['folders'].values())
root=Path(p['rootfs']);release_root=root/p['releaseRoot'].lstrip('/')
working=subprocess.check_output(['systemctl','show',p['service'],'-p','WorkingDirectory'],universal_newlines=True).strip().split('=',1)[1]
if 'currentLink' in p:
 current=root/p['currentLink'].lstrip('/');assert current.is_symlink(),'Expected managed current symlink'
 active=current.resolve();expected_working=p['currentLink']+'/app';assert working==expected_working,'Unexpected service working directory'
else:
 assert working.startswith(p['releaseRoot']+'/'),'Unexpected service working directory'
 active=root/working.lstrip('/')
assert active.parent==release_root and active.resolve()==active and active.is_dir(),'Unexpected active release path'
prior={};manifest_path=None
for candidate in ['sync-manifest.json','source-manifest.json','manifest.json']:
 path=active/candidate
 if path.is_file() and not path.is_symlink():
  previous=json.loads(path.read_text());manifest_path=candidate
  if candidate=='source-manifest.json':prior=previous
  elif isinstance(previous.get('files'),dict):prior=previous['files']
  else:prior={f['path']:f['sha256'] for f in previous['files']}
  break
assert manifest_path and all(allowed(name) for name in prior),'Missing or unrecognized managed source manifest'
owned=set(prior)|set(LOCAL_FILES);actual={};unsafe=[];extra=[]
for name in sorted(owned):
 assert allowed(name),'Protected path outside source scope'
 path=active/name
 if path.is_symlink() or path.resolve()!=path.absolute():unsafe.append(name)
 elif path.is_file():actual[name]=digest(path)
 elif path.exists():unsafe.append(name)
for target in p['folders'].values():
 directory=active/target
 if directory.is_symlink():unsafe.append(target);continue
 if directory.is_dir():
  import os
  for parent,dirs,names in os.walk(str(directory),followlinks=False):
   for item in dirs[:]:
    path=Path(parent)/item
    if path.is_symlink():unsafe.append(path.relative_to(active).as_posix());dirs.remove(item)
   for item in names:
    path=Path(parent)/item;name=path.relative_to(active).as_posix()
    if name not in owned:extra.append(name)
assert not unsafe,'Unsafe paths in active source: '+repr(unsafe)
print(json.dumps({'activeRelease':str(active),'workingDirectory':working,'service':p['service'],'manifest':manifest_path,'manifestSha256':digest(active/manifest_path),'files':actual,'manifestedFiles':prior,'unknownExtraPaths':sorted(extra),'readOnly':True}))
'''
    code = 'PROFILE=' + repr(remote_profile) + '\nLOCAL_FILES=' + repr(list(local_manifest)) + '\n' + probe
    with connect() as client:
        _, stdout, stderr = client.exec_command('python3 -c ' + shlex.quote(code), timeout=60)
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8', 'replace')
        if stdout.channel.recv_exit_status():
            raise RuntimeError('Read-only comparison failed: ' + error[-2000:])
    remote = json.loads(output)
    actual = remote['files']
    remote['same'] = sorted(name for name, value in local_manifest.items() if actual.get(name) == value)
    remote['different'] = sorted(name for name, value in local_manifest.items() if name in actual and actual[name] != value)
    remote['missingOnServer'] = sorted(set(local_manifest) - set(actual))
    remote['previouslyManagedOnly'] = sorted(set(remote['manifestedFiles']) - set(local_manifest))
    remote['serverDrift'] = sorted(name for name, value in remote['manifestedFiles'].items() if actual.get(name) != value)
    return remote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, help='New directory beneath this project runtime/sync/')
    parser.add_argument('--bundle', action='store_true', help='Freeze a code-only archive')
    parser.add_argument('--compare', action='store_true', help='Read actual server release and source hashes; no writes')
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute():
        output = PROJECT_ROOT / output
    output = output.resolve()
    permitted = (PROJECT_ROOT / 'runtime/sync').resolve()
    if output == permitted or not output.is_relative_to(permitted) or output.exists():
        raise RuntimeError('Output must be a new directory below this project runtime/sync/')
    files = source_files()
    manifest = {name: sha(path) for name, path in files.items()}
    now = datetime.now(timezone.utc)
    plan = {'project': PROFILE['project'], 'release': PROFILE['project'] + '-sync-' + now.strftime('%Y%m%dT%H%M%S%fZ'),
            'createdAt': now.isoformat(), 'sourceRoot': str(PROJECT_ROOT / PROFILE['source']),
            'url': PROFILE['origin'] + PROFILE['basePath'], 'service': PROFILE['service'],
            'files': manifest, 'serverWrites': False, 'databaseIncluded': False}
    output.mkdir(parents=True)
    if args.bundle:
        archive_path = output / 'application.tar.gz'
        with tarfile.open(archive_path, 'w:gz') as archive:
            for name, path in files.items():
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != manifest[name]:
                    raise RuntimeError('Source changed while freezing: ' + name)
                entry = tarfile.TarInfo(name);entry.size = len(data);entry.mode = 0o644
                archive.addfile(entry, io.BytesIO(data))
            data = json.dumps(plan, ensure_ascii=False, indent=2).encode('utf-8')
            entry = tarfile.TarInfo('sync-manifest.json');entry.size = len(data);entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(data))
        plan['archive'] = archive_path.name
        plan['archiveSha256'] = sha(archive_path)
    (output / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
    summary = {'project': PROFILE['project'], 'files': len(files), 'output': str(output), 'serverWrites': False}
    if args.bundle:
        summary['archiveSha256'] = plan['archiveSha256']
    if args.compare:
        remote = compare(manifest)
        (output / 'server-comparison.json').write_text(json.dumps(remote, ensure_ascii=False, indent=2), encoding='utf-8')
        summary.update({name: len(remote[name]) for name in ['same', 'different', 'missingOnServer', 'previouslyManagedOnly', 'serverDrift', 'unknownExtraPaths']})
        summary['activeRelease'] = remote['activeRelease']
    print(json.dumps(summary, ensure_ascii=True))


if __name__ == '__main__':
    main()
