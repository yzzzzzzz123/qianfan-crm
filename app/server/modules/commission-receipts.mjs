import {all} from '../database.mjs';
import {contractSplit} from '../sales-policy.mjs';

export function commissionReceiptReview(db,actor,month){
  if(!/^\d{4}-\d{2}$/.test(month))return [];
  const items=all(db,'SELECT * FROM contract_items');
  return all(db,`SELECT p.*,c.id linked_contract_id,c.name contract_name,c.contract_no,c.amount contract_amount,c.owner_id,c.commission_policy,u.name sales_name,u.role sales_role,u.business_member,u.developer_admin FROM payments p JOIN contracts c ON c.id=p.contract_id LEFT JOIN users u ON u.id=c.owner_id WHERE c.retired_at IS NULL AND c.lifecycle!='草稿' AND p.status='已到账' AND substr(p.pay_date,1,7)=? ORDER BY p.pay_date,p.id`,month)
    .filter(p=>actor.role==='admin'||actor.role==='sales'&&p.owner_id===actor.id)
    .map(p=>{
      const issues=[];
      const split=contractSplit({id:p.contract_id,amount:p.contract_amount},items);
      if(!p.owner_id)issues.push('合同销售归属未确定');
      else if(p.business_member!==1||p.developer_admin===1)issues.push('合同归属不是业务成员');
      if(!split.valid)issues.push(split.reason);
      let product=p.product_amount;
      if(product==null&&split.valid){if(!split.product)product=0;else if(!split.service)product=p.amount;else issues.push('混合合同本笔产品回款分配未填写');}
      if(p.sales_role==='admin'&&p.commission_policy!=='legacy')issues.push('管理者个人合同未确认历史毛利计提规则');
      return {payment_id:p.id,contract_id:p.contract_id,contract_no:p.contract_no,contract_name:p.contract_name,sales_id:p.owner_id,sales_name:p.sales_name||'归属待核对',date:p.pay_date,amount:p.amount,product_amount:product,service_received:product==null?null:p.amount-product,issues};
    });
}
