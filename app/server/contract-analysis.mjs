import {createHash} from 'node:crypto';
import {one,run,transaction} from './database.mjs';
import {assert,now} from './domain.mjs';
import {AI_MODEL,normalizeContractExtraction} from './ai-intake.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const empty=()=>({total_amount:null,payment_stages:[],summary:'',questions:[]});
export function createContractAnalysis({db,ai,scoped,audit}) {
  const pending=new Set();
  function current(actor,write=false){
    const user=one(db,'SELECT role,active,business_member,developer_admin FROM users WHERE id=?',actor.id);
    assert(user&&user.active===1&&user.business_member===1&&user.developer_admin===0&&user.role===actor.role,'当前业务身份已失效',403);
    assert(user.role!=='pm'&&(!write||user.role==='admin'),'无权读取或提取合同附件正文',403);
  }
  function snapshot(contractId,attachmentId,actor){
    current(actor);const contract=scoped('contracts',contractId,actor);
    const attachment=one(db,"SELECT * FROM attachments WHERE id=? AND entity='contract' AND entity_id=?",Number(attachmentId),contract.id);
    assert(attachment,'请选择本合同的原附件',404);
    const bytes=Buffer.from(attachment.content),hash=digest(bytes);
    assert(hash===attachment.sha256&&bytes.length===attachment.size,'合同附件校验失败，请核对原附件',409);
    const fingerprint=digest(JSON.stringify({contract,attachment:{id:attachment.id,filename:attachment.filename,mime_type:attachment.mime_type,size:attachment.size,sha256:hash,entity:attachment.entity,entity_id:attachment.entity_id}}));
    return {contract,attachment,bytes,hash,fingerprint};
  }
  const view=row=>({state:row.state,filename:row.filename,model:row.model,generated_at:row.generated_at,reason:row.reason,result:JSON.parse(row.result)});
  function describe(contractId,actor){
    current(actor);const contract=scoped('contracts',contractId,actor);
    const row=one(db,'SELECT * FROM contract_attachment_analyses WHERE contract_id=? ORDER BY generated_at DESC,id DESC LIMIT 1',contract.id);
    if(!row)return null;
    let valid=false;try{valid=snapshot(contract.id,row.attachment_id,actor).fingerprint===row.fingerprint;}catch(error){if(error.status===403)throw error;}
    return valid?view(row):{...view(row),state:'failed',reason:'合同或附件已更新，请重新提取；之前结果未作为当前业务事实。',result:empty()};
  }
  async function extract(actor,contractId,attachmentId,{authorize=()=>{}}={}){
    await authorize();current(actor,true);
    const before=snapshot(contractId,attachmentId,actor);
    const cached=one(db,"SELECT * FROM contract_attachment_analyses WHERE contract_id=? AND attachment_sha256=? AND fingerprint=? AND model=? AND state='ready'",before.contract.id,before.hash,before.fingerprint,AI_MODEL);
    if(cached)return view(cached);
    const key=before.contract.id+':'+before.hash+':'+before.fingerprint;
    assert(!pending.has(key),'该合同附件正在识别，请稍后查看结果',409);pending.add(key);
    try{
      let state='failed',reason='',result=empty();
      if(!ai?.configured||typeof ai.extractContract!=='function')reason='派欧云Qwen尚未配置，合同附件尚未识别；原合同与回款记录保持不变。';
      else if(ai.model&&ai.model!==AI_MODEL)reason='合同附件识别模型配置不符合当前指定模型，未调用其他模型。';
      else if(before.bytes.length>10*1024*1024)reason='合同附件超过10MB识别限制，请拆分后再读取；原附件完整保留。';
      else if(!/\.(txt|md|markdown|csv|json|xlsx|docx|pdf|png|jpe?g|webp)$/i.test(before.attachment.filename))reason='当前合同附件格式不支持AI读取，原附件完整保留。';
      else {
        try{
          const output=await ai.extractContract({name:before.attachment.filename,base64:before.bytes.toString('base64')});
          assert(output?.model===AI_MODEL,'合同识别模型不一致',502);
          result=normalizeContractExtraction(output.result,{amountsInCents:true});state='ready';
          reason='仅保存原件识别结果，请核对原文；未修改合同金额、付款计划或到账记录。';
        }catch(error){
          reason=error.status===422?'合同附件解析失败或超过图片/文本限制，请检查原件后重试；原附件完整保留。':error.status===429?'AI正在处理其他资料，请稍后重试；尚未识别此附件。':'合同附件AI提取失败或结果无法校验，请稍后重试；未修改合同或回款记录。';
        }
      }
      await authorize();current(actor,true);
      assert(snapshot(contractId,attachmentId,actor).fingerprint===before.fingerprint,'合同或附件在识别期间发生变化，请重新提取',409);
      return transaction(db,()=>{
        current(actor,true);assert(snapshot(contractId,attachmentId,actor).fingerprint===before.fingerprint,'合同或附件已变化，请重新提取',409);
        const generated_at=now();
        run(db,`INSERT INTO contract_attachment_analyses(contract_id,attachment_id,attachment_sha256,fingerprint,filename,model,state,result,reason,generated_at,generated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(contract_id,attachment_sha256,fingerprint,model) DO UPDATE SET state=excluded.state,result=excluded.result,reason=excluded.reason,generated_at=excluded.generated_at,generated_by=excluded.generated_by`,before.contract.id,before.attachment.id,before.hash,before.fingerprint,before.attachment.filename,AI_MODEL,state,JSON.stringify(result),reason,generated_at,actor.id);
        audit(actor,'提取合同附件信息','contract',before.contract.id,{attachment_id:before.attachment.id,attachment_sha256:before.hash,model:AI_MODEL,state});
        return {state,filename:before.attachment.filename,model:AI_MODEL,generated_at,reason,result};
      });
    }finally{pending.delete(key);}
  }
  return {describe,extract};
}
