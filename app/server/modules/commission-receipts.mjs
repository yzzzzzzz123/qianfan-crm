import {all} from '../database.mjs';
import {receiptMarginLedger} from './receipt-margins.mjs';

export function commissionReceiptReview(db,actor,month){
  if(!/^\d{4}-\d{2}$/.test(month))return [];
  const users=new Map(all(db,'SELECT id,name,role,business_member,developer_admin FROM users').map(u=>[u.id,u]));
  return receiptMarginLedger(db,month).rows.filter(p=>p.date&&(actor.role==='admin'||actor.role==='sales'&&p.sales_id===actor.id)).map(({items,...p})=>{
    const user=users.get(p.sales_id),issues=[...p.issues];
    if(!user)issues.push('合同销售归属未确定');
    else if(user.business_member!==1||user.developer_admin===1||!['sales','admin'].includes(user.role))issues.push('合同归属不是参与计提的业务销售');
    return {...p,sales_name:user?.name||'归属待核对',issues};
  });
}
