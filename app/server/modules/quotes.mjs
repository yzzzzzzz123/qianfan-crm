import { assert, choice, text, cents, validDate, now } from "../domain.mjs";
import {intakeSchema} from '../../public/modules/intake-schema.js';

/** quotes: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleQuotes(context) {
  const { path, method, b, actor, insert, scoped, audit } = context;
  if (path === "/api/quotes" && method === "POST") {
    const o = scoped("opportunities", b.opportunity_id, actor);
    assert(o.owner_id,'请先为商机分配负责人');
    let items=[],amount;
    {
      assert(Array.isArray(b.items)&&b.items.length>0&&b.items.length<=100,'报价须包含1至100条产品或服务明细');
      items=b.items.map(row=>{
        assert(row&&typeof row==='object'&&!Array.isArray(row),'报价明细须为产品或服务记录');
        assert(Object.keys(row).every(key=>intakeSchema.quote.itemsSchema.fields.includes(key)),'报价明细包含不支持字段');
        const quantity=Number(row.quantity);
        assert((typeof row.quantity==='number'||typeof row.quantity==='string'&&row.quantity.trim()!=='')&&Number.isFinite(quantity)&&quantity>0&&quantity<=1000000&&Math.abs(quantity*100-Math.round(quantity*100))<0.001,'数量须大于零且最多保留两位小数');
        const price=cents(row.list_price,'原价单价');
        const discount=row.discount_rate===undefined?1:Number(row.discount_rate);
        assert((typeof row.discount_rate==='number'||row.discount_rate===undefined||typeof row.discount_rate==='string'&&row.discount_rate.trim()!=='')&&Number.isFinite(discount)&&discount>=0&&discount<=1,'折扣比例须为0至1');
        const list=Math.round(price*quantity),net=Math.round(list*discount);
        assert(Number.isSafeInteger(list)&&list<=1e12,'报价行金额超出允许范围');
        return {name:text(row.name,'报价行名称',160),kind:choice(row.kind,['标品','实施','定开','交付','运维'],'报价行类型'),quantity,list_price:price,discount_rate:discount,list_amount:list,amount:net};
      });
      amount=items.reduce((sum,row)=>sum+row.amount,0);
      assert(Number.isSafeInteger(amount)&&amount>0&&amount<=1e12,'报价总金额须大于零且在允许范围内');
      if(b.amount!==undefined)assert(cents(b.amount,'报价总额')===amount,'报价总额与明细折后合计不一致');
    }
    const id = insert("quotes", {
      opportunity_id: o.id,
      user_id: o.owner_id,
      amount,
      items:JSON.stringify(items),
      valid_until: validDate(b.valid_until, "报价有效期"),
      note: text(b.note || "", "报价说明", 2000, false),
      created_at: now(),
    });
    audit(actor, "登记报价", "opportunity", o.id, { quote_id: id });
    return { id, message: "报价已登记，可在商机详情导出报价文件" };
  }
}
