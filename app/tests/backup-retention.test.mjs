import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {backup,receipt,prune} from '../../deploy/backup.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qf-backup-policy-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source.sqlite'),directory=path.join(root,'backups');
  fs.mkdirSync(directory);
  const db=new DatabaseSync(source);db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1,\'preserved\')');db.close();
  function add(kind,n) {
    const createdAt=`2020-01-${String(n).padStart(2,'0')}T00:00:00.000Z`,name='crm-'+kind+'-'+createdAt.replaceAll(':','-')+'.sqlite';
    fs.copyFileSync(source,path.join(directory,name));receipt(directory,name,kind,createdAt);return name;
  }
  return {root,source,directory,add};
}
test('verified backup retains seven daily and two release copies independently',t=>{
  const f=fixture(t);
  for(let n=1;n<=9;n++)f.add('daily',n);
  for(let n=1;n<=3;n++)f.add('release',n);
  fs.writeFileSync(path.join(f.directory,'unmanaged.txt'),'preserve');
  const result=backup({...f,kind:'release'});
  assert.equal(result.retention.kept.daily.length,7);assert.equal(result.retention.kept.release.length,2);
  assert.equal(result.retention.removed.length,4);
  assert.ok(fs.existsSync(path.join(f.directory,'unmanaged.txt')));
  const copy=new DatabaseSync(path.join(f.directory,result.backup),{readOnly:true});
  try {assert.equal(copy.prepare('SELECT value FROM sample').get().value,'preserved');}finally {copy.close();}
});
test('backup failure and checksum mismatch never prune prior copies',t=>{
  const f=fixture(t);for(let n=1;n<=8;n++)f.add('daily',n);
  const names=fs.readdirSync(f.directory);const broken=path.join(f.root,'broken.sqlite');fs.writeFileSync(broken,'invalid');
  assert.throws(()=>backup({...f,source:broken,kind:'daily'}));
  assert.ok(names.every(n=>fs.existsSync(path.join(f.directory,n))));
  fs.appendFileSync(path.join(f.directory,names.find(n=>n.endsWith('.sqlite'))),'tamper');
  assert.throws(()=>prune(f.directory),/changed/);
  assert.ok(names.every(n=>fs.existsSync(path.join(f.directory,n))));
});
test('existing backup lock prevents a concurrent run',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.directory,'.backup.lock'),'active');
  assert.throws(()=>backup(f),{code:'EEXIST'});
  assert.equal(fs.readFileSync(path.join(f.directory,'.backup.lock'),'utf8'),'active');
});
test('CLI reached through a current version link actually creates and verifies a backup',t=>{
  const f=fixture(t),link=path.join(f.root,'current');
  fs.symlinkSync(fileURLToPath(new URL('../../',import.meta.url)),link,'junction');
  const result=spawnSync(process.execPath,[path.join(link,'deploy','backup.mjs'),'--kind','daily'],{env:{...process.env,DB_PATH:f.source,QF_BACKUP_DIR:f.directory},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.kind,'daily');assert.equal(report.integrity,'ok');
  assert.ok(fs.existsSync(path.join(f.directory,report.backup)));
});
