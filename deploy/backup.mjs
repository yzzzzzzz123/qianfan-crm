import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

export const KEEP = Object.freeze({daily:7,release:2});
const safeName = /^crm-(?:(?:daily|release)-)?\d{4}-\d{2}-\d{2}T[\d.-]+Z\.sqlite$/;
export function digest(file) {
  const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');
  try {let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));}
  finally {fs.closeSync(fd);}
  return hash.digest('hex');
}
function regular(file) {return fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink();}
export function verifySqlite(file) {
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    if(db.prepare('PRAGMA integrity_check').all().some(row=>row.integrity_check!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('SQLite backup verification failed');
  } finally {db.close();}
}
export function receipt(directory,name,kind,createdAt) {
  if(!safeName.test(name)||!Object.hasOwn(KEEP,kind)||!Number.isFinite(Date.parse(createdAt)))throw new Error('Invalid backup metadata');
  const file=path.join(directory,name);
  if(!regular(file))throw new Error('Backup must be a regular file');
  verifySqlite(file);
  const value={version:1,kind,createdAt,file:name,bytes:fs.statSync(file).size,sha256:digest(file),integrity:'ok'};
  fs.writeFileSync(file+'.json',JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  return value;
}
export function prune(directory) {
  const entries=[];
  for(const name of fs.readdirSync(directory).filter(n=>safeName.test(n.replace(/\.json$/,''))&&n.endsWith('.json'))) {
    const meta=path.join(directory,name);
    if(!regular(meta))throw new Error('Linked backup metadata rejected');
    const r=JSON.parse(fs.readFileSync(meta,'utf8'));
    if(r.version!==1||!Object.hasOwn(KEEP,r.kind)||name!==r.file+'.json'||!safeName.test(r.file)||!Number.isFinite(Date.parse(r.createdAt)))throw new Error('Invalid backup receipt');
    const file=path.join(directory,r.file);
    if(!regular(file)||fs.statSync(file).size!==r.bytes||digest(file)!==r.sha256||r.integrity!=='ok')throw new Error('Backup changed; retention aborted');
    for(const suffix of ['-wal','-shm'])if(fs.existsSync(file+suffix)&&(!regular(file+suffix)||(suffix==='-wal'&&fs.statSync(file+suffix).size)))throw new Error('Uncheckpointed backup rejected');
    entries.push(r);
  }
  const removed=[],kept={};
  // Validate the complete candidate set before the first deletion.
  for(const [kind,limit] of Object.entries(KEEP)) {
    const group=entries.filter(r=>r.kind===kind).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.file.localeCompare(a.file));
    kept[kind]=group.slice(0,limit).map(r=>r.file);
    for(const r of group.slice(limit)) {
      const file=path.join(directory,r.file);
      for(const suffix of ['-shm','-wal'])if(fs.existsSync(file+suffix))fs.unlinkSync(file+suffix);
      fs.unlinkSync(file);fs.unlinkSync(file+'.json');removed.push({file:r.file,bytes:r.bytes});
    }
  }
  return {kept,removed};
}
export function backup({directory,source,kind='release'}) {
  if(!Object.hasOwn(KEEP,kind))throw new Error('Backup kind must be daily or release');
  if(!fs.existsSync(source))throw new Error('Source database is missing');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.realpathSync(directory)!==path.resolve(directory))throw new Error('Linked backup directory rejected');
  const lock=path.join(directory,'.backup.lock'),fd=fs.openSync(lock,'wx',0o600);
  try {
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
    const createdAt=new Date().toISOString(),name='crm-'+kind+'-'+createdAt.replaceAll(':','-')+'.sqlite',file=path.join(directory,name);
    const db=new DatabaseSync(source,{readOnly:true});
    try {db.prepare('VACUUM INTO ?').run(file);}finally {db.close();}
    fs.chmodSync(file,0o600);
    const r=receipt(directory,name,kind,createdAt);
    return {backup:name,kind,integrity:'ok',sha256:r.sha256,bytes:r.bytes,retention:prune(directory)};
  } finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--kind'&&Object.hasOwn(KEEP,args[1])))throw new Error('Usage: backup.mjs [--kind daily|release]');
  console.log(JSON.stringify(backup({directory:process.env.QF_BACKUP_DIR||'/srv/qianfan-crm/backups',source:process.env.DB_PATH||'/srv/qianfan-crm/data/crm.sqlite',kind:args[1]||'release'})));
}
