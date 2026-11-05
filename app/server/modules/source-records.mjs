import { createHash } from 'node:crypto';
import { all, one } from '../database.mjs';
import { assert, now } from '../domain.mjs';

const tables={customer:'customers',opportunity:'opportunities',contract:'contracts'};
export function sourceAccess(ctx,entity,id,actor) {
  if(tables[entity])return ctx.scoped(tables[entity],id,actor,entity==='opportunity'?'follow':'edit');
  const related={contact:['contacts','customer_id','customers'],activity:['activities','opportunity_id','opportunities'],quote:['quotes','opportunity_id','opportunities'],payment:['payments','contract_id','contracts']};
  const def=related[entity];assert(def,'资料对象无效');
  const record=one(ctx.db,`SELECT * FROM ${def[0]} WHERE id=?`,id);assert(record,'记录不存在',404);
  ctx.scoped(def[2],record[def[1]],actor,entity==='activity'?'follow':'edit');return record;
}
export function readSources(ctx,params,actor) {
  const entity=params.get('entity'),id=Number(params.get('id'));
  const clauses=[],args=[];
  if(entity) {assert(Number.isSafeInteger(id)&&id>0,'记录编号无效');sourceAccess(ctx,entity,id,actor);clauses.push('entity=? AND entity_id=?');args.push(entity,id);}
  else assert(actor.role==='admin','仅管理员可查看全量历史资料',403);
  for(const [key,column] of [['status','status'],['sheet','source_table']])if(params.has(key)){clauses.push(`${column}=?`);args.push(params.get(key));}
  const limit=Math.min(100,Math.max(1,Number(params.get('limit'))||50)),offset=Math.max(0,Number(params.get('offset'))||0);
  assert(Number.isSafeInteger(limit)&&Number.isSafeInteger(offset),'分页参数无效');
  const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
  const records=all(ctx.db,`SELECT * FROM source_records ${where} ORDER BY id LIMIT ? OFFSET ?`,...args,limit,offset).map(({payload,...row})=>({...row,source_sheet:row.sheet_name,source_row:row.row_number,raw:JSON.parse(payload)}));
  const counts=actor.role==='admin'?all(ctx.db,'SELECT source_table,status,COUNT(*) count FROM source_records GROUP BY source_table,status ORDER BY source_table,status'):[];
  return {records,total:one(ctx.db,`SELECT COUNT(*) count FROM source_records ${where}`,...args).count,counts,limit,offset};
}
export function readAttachment(ctx,id,actor) {
  const row=one(ctx.db,'SELECT * FROM attachments WHERE id=?',id);assert(row,'附件不存在',404);
  sourceAccess(ctx,row.entity,row.entity_id,actor);
  return {filename:row.filename,mime_type:row.mime_type,base64:Buffer.from(row.content).toString('base64')};
}
export function attachContractFile(ctx,contractId,file) {
  assert(ctx.actor.role==='admin','合同附件须由管理员维护',403);
  ctx.scoped('contracts',contractId,ctx.actor);
  const filename=file.name||file.filename;
  assert(typeof filename==='string'&&filename.length<=255&&!/[\\/\x00-\x1f]/.test(filename),'附件名无效');
  const content=file.content?Buffer.from(file.content):Buffer.from(file.base64||'','base64');
  assert(content.length>0&&content.length<=60*1024*1024,'合同附件为空或超过60MB');
  const ext=filename.split('.').pop().toLowerCase();
  const types={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',txt:'text/plain',md:'text/markdown'};
  assert(types[ext],'合同附件格式不支持');
  if(ext==='pdf')assert(content.subarray(0,5).toString()==='%PDF-','PDF附件内容与文件类型不符');
  const sha256=createHash('sha256').update(content).digest('hex');
  const existing=one(ctx.db,"SELECT id FROM attachments WHERE entity='contract' AND entity_id=? AND sha256=?",contractId,sha256);
  if(existing)return existing.id;
  return ctx.insert('attachments',{entity:'contract',entity_id:contractId,filename,mime_type:types[ext],size:content.length,sha256,content,source_path:filename,created_at:now(),created_by:ctx.actor.id});
}
