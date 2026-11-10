import {assertContractDataAccess} from '../contract-access.mjs';
import {all,one} from '../database.mjs';
import {ledgerPayments} from '../collection-ledger.mjs';
import {assert} from '../domain.mjs';
import {contractFinancials} from './reporting-prd.mjs';
import {contractLocks} from './incentives.mjs';

export function readContractHistory({db,scoped},actor,id) {
  assertContractDataAccess(actor);
  if(!id)return {contracts:all(db,"SELECT c.*,u.name owner_name,cu.name customer_name,(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.contract_id=c.id AND p.status='已到账') collected FROM contracts c LEFT JOIN customers cu ON cu.id=c.customer_id LEFT JOIN users u ON u.id=c.owner_id WHERE (c.retired_at IS NOT NULL OR c.terminated_at IS NOT NULL) AND (?='admin' OR c.owner_id=?) ORDER BY COALESCE(c.terminated_at,c.retired_at) DESC,c.id DESC LIMIT 100",actor.role,actor.id)};
  const c=scoped('contracts',id,actor,'history'),items=all(db,'SELECT * FROM contract_items WHERE retired_at IS NULL AND contract_id=?',c.id),payments=ledgerPayments(db,c.id);
  const collected=payments.filter(p=>p.status==='已到账').reduce((sum,p)=>sum+p.amount,0);
  return {...c,...contractFinancials(c,items),read_only:true,items,payments,code:c.contract_no||`HT-${c.id}`,collected,outstanding:c.amount-collected,collection_status:collected===0?'未回款':collected<c.amount?'部分回款':'已结清',locks:contractLocks(db,c.id),
    attachments:all(db,"SELECT id,filename,mime_type,size,created_at FROM attachments WHERE entity='contract' AND entity_id=?",c.id),
    history:all(db,"SELECT a.id,a.action,a.detail,a.created_at,u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity='contract' AND a.entity_id=? ORDER BY a.id DESC LIMIT 100",c.id).map(r=>({...r,detail:JSON.parse(r.detail||'{}')}))};
}
