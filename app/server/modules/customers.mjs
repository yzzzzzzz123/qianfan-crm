import { assert, text, choice, now, similarCustomer, validDate } from "../domain.mjs";
import { one, run } from "../database.mjs";
import { all } from "../database.mjs";
import { assertOwnershipUnlocked } from "./incentives.mjs";
import {normalizeCompanyName,normalizeCreditCode,assertCustomerIdentityUnique} from '../company-profile.mjs';

/** customers: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleCustomers(context) {
  const {
    path,
    method,
    b,
    actor,
    db,
    insert,
    update,
    scoped,
    admin,
    owner,
    audit,
    getRules,
  } = context;
  let m;
  if ((m = path.match(/^\/api\/contacts\/(\d+)$/)) && method === 'PATCH') {
    const contact = one(db, 'SELECT * FROM contacts WHERE id=?', Number(m[1]));
    assert(contact, '联系人不存在', 404);
    scoped('customers', contact.customer_id, actor);
    const row = {};
    for (const [key,label,max] of [['name','联系人',40],['title','职位',80],['phone','电话',40],['wechat','微信',100],['dingtalk','钉钉',100],['note','备注',1000]]) {
      if (b[key] !== undefined) row[key] = text(b[key],label,max,key==='name');
    }
    if (b.role !== undefined) row.role = choice(b.role,['决策人','影响者','使用人','把关人','我方PM'],'角色');
    if (b.attitude !== undefined) row.attitude = choice(b.attitude,['支持','中立','反对'],'态度');
    if (b.last_contact !== undefined) row.last_contact = validDate(b.last_contact,'最近触达日期',true);
    if(['phone','wechat','dingtalk'].some(k=>b[k]!==undefined))assert(['phone','wechat','dingtalk'].some(k=>String(row[k]??contact[k]??'').trim()),'请至少保留电话、微信或钉钉中的一种联系方式');
    if (b.active !== undefined) {
      assert([true,false,'true','false'].includes(b.active),'联系人状态无效');
      row.archived_at = b.active===true || b.active==='true' ? null : contact.archived_at || now();
    }
    assert(Object.keys(row).length,'没有可更新内容');
    update('contacts',contact.id,row);
    audit(actor,'更新联系人','customer',contact.customer_id,{contact_id:contact.id,before:contact,after:row});
    return {id:contact.id,message:row.archived_at?'联系人已停用，历史资料保留':'联系人已更新'};
  }
  if (path === "/api/customers" && method === "POST") {
    assert(actor.role!=='pm','协作PM不能建立客户',403);
    assert(!Object.hasOwn(b,'level'),'旧客户等级字段已退役，请使用手动客户等级');
    assert(actor.role!=='admin'||Number.isSafeInteger(Number(b.owner_id))&&Number(b.owner_id)>0,'请选择客户负责人');
    const name = text(b.name, "客户全称", 120);
    const norm = normalizeCompanyName(name);
    const credit = normalizeCreditCode(text(b.credit_code || "", "统一社会信用代码", 40, false));
    assertCustomerIdentityUnique(db,{name,credit_code:credit});
    const similar=all(db,'SELECT name FROM customers').filter(c=>similarCustomer(name,c.name));
    assert(!similar.length||b.duplicate_ack===true||b.duplicate_ack==='on','存在疑似同名客户：'+similar.slice(0,3).map(c=>c.name).join('、')+'。请先核对档案；确认不同企业后勾选允许新建。',409);
    assert(
      !one(db, "SELECT id FROM customers WHERE normalized=?", norm),
      "已有同名客户，请先查看客户档案",
      409,
    );
    assert(
      !credit ||
        !one(db, "SELECT id FROM customers WHERE credit_code=?", credit),
      "统一社会信用代码已存在",
      409,
    );
    const id = insert("customers", {
      name,
      normalized: norm,
      short_name: text(b.short_name || "", "简称", 30, false),
      industry: text(b.industry || "", "行业", 40, false),
      region: text(b.region || "", "地区", 40, false),
      manual_level:b.manual_level?choice(b.manual_level,getRules().customer_levels,'手动客户等级'):null,
      owner_id: owner(b.owner_id, actor),
      status: "潜在",
      credit_code: credit,
      scale: text(b.scale || "", "规模", 40, false),
      note: text(b.note || "", "备注", 2000, false),
      parent_company:text(b.parent_company||'','母公司',120,false),
      group_name:text(b.group_name||'','集团',120,false),
      tags:text(b.tags||'','企业标签',500,false),
      compliance_flag:text(b.compliance_flag||'','流程标记',200,false),
      created_at: now(),
      updated_at: now(),
    });
    audit(actor, "创建客户", "customer", id, { name });
    context.companyProfiles?.initialize(id);
    return { id, message: "客户已创建" };
  }
  if ((m = path.match(/^\/api\/customers\/(\d+)$/)) && method === "PATCH") {
    const c = scoped("customers", m[1], actor);
    assert(!Object.hasOwn(b,'level'),'旧客户等级字段已退役，请使用手动客户等级');
    const row = { updated_at: now() };
    for (const k of [
      "name",
      "short_name",
      "industry",
      "region",
      "scale",
      "credit_code",
      "note",
      "parent_company", "group_name", "tags", "compliance_flag",
    ])
      if (b[k] !== undefined)
        row[k] = text(
          b[k],
          k === "name" ? "客户全称" : "字段",
          ({note:2000,tags:500,compliance_flag:200})[k] ?? 120,
          k === "name",
        );
    if (row.name&&normalizeCompanyName(row.name)!==normalizeCompanyName(c.name)) {
      row.normalized = normalizeCompanyName(row.name);
      assertCustomerIdentityUnique(db,{name:row.name},c.id);
      assert(
        !one(
          db,
          "SELECT id FROM customers WHERE normalized=? AND id!=?",
          row.normalized,
          c.id,
        ),
        "已有同名客户",
        409,
      );
    }
    if(row.credit_code!==undefined&&row.credit_code!==c.credit_code)row.credit_code=normalizeCreditCode(row.credit_code)===normalizeCreditCode(c.credit_code)?c.credit_code:normalizeCreditCode(row.credit_code);
    if(row.credit_code&&normalizeCreditCode(row.credit_code)!==normalizeCreditCode(c.credit_code))assertCustomerIdentityUnique(db,{credit_code:row.credit_code},c.id);
    if (row.credit_code&&row.credit_code!==c.credit_code)
      assert(
        !one(
          db,
          "SELECT id FROM customers WHERE credit_code=? AND id!=?",
          row.credit_code,
          c.id,
        ),
        "统一社会信用代码已存在",
        409,
      );
    if(b.manual_level!==undefined)row.manual_level=b.manual_level===''||b.manual_level===null?null:choice(b.manual_level,[...getRules().customer_levels,...(c.manual_level?[c.manual_level]:[])],'手动客户等级');
    if (b.status !== undefined)
      row.status = choice(b.status, ["潜在", "成交", "流失", "冻结"], "状态");
    const preservesMissingOwner=c.owner_id===null&&(b.owner_id===null||b.owner_id==='');
    if (b.owner_id !== undefined && !preservesMissingOwner && Number(b.owner_id) !== c.owner_id) {
      admin(actor);
      text(b.reason, "归属调整原因", 500);
      row.owner_id = owner(b.owner_id, actor);
      for(const contract of all(db,'SELECT id FROM contracts WHERE retired_at IS NULL AND customer_id=? AND owner_id IS ?',c.id,c.owner_id)) assertOwnershipUnlocked(db,contract.id);
      run(
        db,
        "UPDATE opportunities SET owner_id=?,updated_at=? WHERE customer_id=? AND owner_id IS ?",
        row.owner_id,
        now(),
        c.id,
        c.owner_id,
      );
      run(
        db,
        "UPDATE contracts SET owner_id=? WHERE customer_id=? AND owner_id IS ?",
        row.owner_id,
        c.id,
        c.owner_id,
      );
    }
    if(b.collaborators!==undefined) {
      admin(actor);assert(Array.isArray(b.collaborators)&&b.collaborators.length<=30,'协作成员无效');
      run(db,'DELETE FROM customer_collaborators WHERE customer_id=?',c.id);
      for(const uid of new Set(b.collaborators.map(Number))) {assert(one(db,'SELECT id FROM users WHERE id=? AND active=1 AND business_member=1 AND developer_admin=0',uid),'协作成员不存在');run(db,'INSERT INTO customer_collaborators VALUES(?,?)',c.id,uid);}
    }
    update("customers", c.id, row);
    audit(actor, "更新客户", "customer", c.id, {
      fields: Object.keys(row),
      reason: b.reason || "",
    });
    return { id: c.id, message: "客户档案已更新" };
  }
  if (path === "/api/contacts" && method === "POST") {
    const c = scoped("customers", b.customer_id, actor);
    assert(['phone','wechat','dingtalk'].some(k=>typeof b[k]==='string'&&b[k].trim()),'请填写电话、微信或钉钉中的至少一种联系方式');
    const id = insert("contacts", {
      customer_id: c.id,
      name: text(b.name, "联系人", 40),
      title: text(b.title || "", "职位", 80, false),
      phone: text(b.phone || "", "电话", 40, false),
      role: choice(
        b.role || "使用人",
        ["决策人", "影响者", "使用人", "把关人", "我方PM"],
        "角色",
      ),
      attitude: choice(b.attitude || "中立", ["支持", "中立", "反对"], "态度"),
      note: text(b.note || "", "备注", 1000, false),
      wechat:text(b.wechat||'','微信',100,false),
      dingtalk:text(b.dingtalk||'','钉钉',100,false),
      last_contact:validDate(b.last_contact,'最近触达日期',true),
    });
    audit(actor, "添加联系人", "customer", c.id, { name: b.name });
    return { id, message: "联系人已添加" };
  }
}
