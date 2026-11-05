import { assert, text, choice, STAGES, now } from "../domain.mjs";
import { one, run } from "../database.mjs";
import {validateSalesPolicy} from '../sales-policy.mjs';
import {performanceDefaults,performancePolicy} from '../../public/modules/performance-policy.js';

/** settings: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleSettings(context) {
  const { path, method, b, actor, db, insert, update, admin, audit, getRules } =
    context;
  let m;
  if (path === "/api/rules" && method === "PATCH") {
    admin(actor);
    const rules = getRules();
    const previousPerformance=performancePolicy(rules.performance);
    const previousSalesPolicy=rules.commission.sales_policy?structuredClone(rules.commission.sales_policy):null;
    if(b.commission) {
      assert(typeof b.commission==='object'&&!Array.isArray(b.commission),'提成规则无效');
      const retired=['standard_self_new','standard_distributed_new','standard_renewal','implementation'];
      assert(!Object.keys(b.commission).some(k=>retired.includes(k)),'旧毛利比例已停用，请在合同明细中维护已核验毛利');
      const allowed=['period','threshold','low_rate','high_rate','manager_id','unlock_by_payment','sales_policy'];
      assert(Object.keys(b.commission).every(k=>allowed.includes(k)),'提成规则包含未知字段');
      for(const [key,value] of Object.entries(b.commission)) {
        if(key==='sales_policy') {
          validateSalesPolicy(value,assert);
          if(previousSalesPolicy&&value.effective_month>previousSalesPolicy.effective_month)
            assert(!one(db,"SELECT 1 FROM commission_batches WHERE kind='personal' AND period>=? AND period<? AND period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' LIMIT 1",previousSalesPolicy.effective_month,value.effective_month),'已有确认的个人月度结算，不能将生效月份调整到其后');
        }
        else if(key==='period') {choice(value,['month','quarter','year'],'累计周期');assert(value===rules.commission.period||!one(db,'SELECT id FROM commission_batches LIMIT 1'),'已有结算记录，不能直接改变累计周期');}
        else if(key==='manager_id')assert(one(db,"SELECT id FROM users WHERE id=? AND active=1 AND role='admin' AND business_member=1 AND developer_admin=0",Number(value)),'管理提成对象须为启用的业务管理者');
        else if(key==='unlock_by_payment')assert(typeof value==='boolean','回款联动须为布尔值');
        else if(key==='threshold')assert(Number.isSafeInteger(value)&&value>0&&value<=1e12,'毛利阈值须为正整数分');
        else assert(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1,'比例须为0至1之间的数');
        rules.commission[key]=value;
      }
      assert(rules.commission.high_rate>=rules.commission.low_rate,'高档提成比例不得低于低档');
    }
    if(b.performance) {
      assert(typeof b.performance==='object'&&!Array.isArray(b.performance),'绩效规则无效');
      const allowed=Object.keys(performanceDefaults);
      for(const [key,value] of Object.entries(b.performance)) {assert(allowed.includes(key),'绩效规则包含未知字段');assert(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100&&Math.abs(value*100-Math.round(value*100))<1e-7,'绩效参数须为0至100，最多两位小数');rules.performance[key]=value;}
      assert(rules.performance.cap>0&&rules.performance.process_weight+rules.performance.result_weight===100,'过程与结果权重之和须为100，过程满分须大于0');
    }
    if(b.customer_levels!==undefined) {
      assert(Array.isArray(b.customer_levels)&&b.customer_levels.length>0&&b.customer_levels.length<=30,'客户等级须为1至30个标签');
      const levels=b.customer_levels.map(v=>text(v,'客户等级',30));
      assert(new Set(levels).size===levels.length,'客户等级不能重复');
      rules.customer_levels=levels;
    }
    if (b.thresholds) {
      for (const [s, v] of Object.entries(b.thresholds)) {
        assert(Object.hasOwn(rules.thresholds, s), "阶段无效");
        assert(
          Number.isInteger(Number(v)) && v >= 1 && v <= 90,
          "停滞阈值应为1至90天",
        );
        rules.thresholds[s] = Number(v);
      }
    }
    if (b.sop) {
      for (const [s, v] of Object.entries(b.sop)) {
        choice(s, STAGES, "阶段");
        rules.sop[s] = text(v, "阶段动作", 1500);
      }
    }
    run(
      db,
      "UPDATE settings SET value=? WHERE key=?",
      JSON.stringify(rules),
      "rules",
    );
    audit(actor, "更新业务规则", "settings", null, {
      fields: Object.keys(b),
      ...(b.commission?.sales_policy?{sales_policy_before:previousSalesPolicy,sales_policy_after:rules.commission.sales_policy}:{}),
      ...(b.performance?{performance_before:Object.fromEntries(Object.keys(performanceDefaults).map(k=>[k,previousPerformance[k]])),performance_after:Object.fromEntries(Object.keys(performanceDefaults).map(k=>[k,performancePolicy(rules.performance)[k]]))}:{}),
    });
    return { message: "业务规则已保存" };
  }
  if (path === "/api/users" && method === "POST") {
    admin(actor);
    const name = text(b.name, "姓名", 40);
    const username = text(b.username, "账号", 60);
    assert(
      /^[a-zA-Z0-9_.-]{3,60}$/.test(username),
      "账号需为3至60位字母、数字或下划线",
    );
    assert(
      !one(db, "SELECT id FROM users WHERE username=?", username),
      "账号已存在",
      409,
    );
    assert(b.password===undefined&&b.dingtalk_only!==false,'成员仅支持钉钉登录，不接收密码');
    const dingUser=b.ding_user_id?text(b.ding_user_id,'钉钉userId',160):null;
    const dingUnion=b.ding_union_id?text(b.ding_union_id,'钉钉unionId',160):null;
    assert(!dingUser||!one(db,'SELECT id FROM users WHERE ding_user_id=?',dingUser),'钉钉身份已绑定其他成员',409);
    assert(!dingUnion||!one(db,'SELECT user_id FROM ding_identities WHERE union_id=?',dingUnion),'钉钉身份已绑定其他成员',409);
    assert(Boolean(dingUser)===Boolean(dingUnion),'钉钉绑定须同时提供已核验的userId和unionId');
    const id = insert("users", {
      name,
      username,
      role: choice(b.role, ["admin", "sales", "pm"], "角色"),
      performance_enabled: b.role==='sales'?1:0,
      ding_user_id:dingUser,
      created_at: now(),
    });
    if(dingUnion)run(db,'INSERT INTO ding_identities VALUES(?,?)',id,dingUnion);
    audit(actor, "添加成员", "user", id, { name, role: b.role });
    return { id, message: "成员已添加" };
  }
  if ((m = path.match(/^\/api\/users\/(\d+)$/)) && method === "PATCH") {
    admin(actor);
    const id = Number(m[1]);
    assert(id !== actor.id || b.active===undefined && (!b.role||b.role===actor.role), "不能停用或降低当前登录账号权限");
    const u = one(db, "SELECT * FROM users WHERE id=?", id);
    assert(u, "成员不存在", 404);
    assert(u.developer_admin!==1&&u.business_member!==0,'开发者登录身份由私有部署配置管理',403);
    if(b.ding_user_id!==undefined || b.ding_union_id!==undefined || b.role!==undefined || b.performance_enabled!==undefined || b.name!==undefined || b.username!==undefined) {
      const row={};
      if(b.name!==undefined)row.name=text(b.name,'姓名',40);
      if(b.username!==undefined) {const name=text(b.username,'账号',60);assert(/^[a-zA-Z0-9_.-]{3,60}$/.test(name),'账号格式无效');assert(!one(db,'SELECT id FROM users WHERE username=? AND id!=?',name,id),'账号已存在',409);row.username=name;}
      if(b.active!==undefined) {assert(typeof b.active==='boolean','成员状态无效');if(!b.active&&u.role==='admin')assert(one(db,"SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND business_member=1 AND developer_admin=0").n>1,'至少保留一名管理员');row.active=b.active?1:0;}
      if(b.ding_user_id!==undefined) {const ding=text(b.ding_user_id,'钉钉userId',160,false);assert(!ding||!one(db,'SELECT id FROM users WHERE ding_user_id=? AND id!=?',ding,id),'钉钉身份已绑定其他成员',409);row.ding_user_id=ding||null;}
      if(b.ding_union_id!==undefined) {const union=text(b.ding_union_id,'钉钉unionId',160,false);assert(!union||!one(db,'SELECT user_id FROM ding_identities WHERE union_id=? AND user_id!=?',union,id),'钉钉身份已绑定其他成员',409);run(db,'DELETE FROM ding_identities WHERE user_id=?',id);if(union)run(db,'INSERT INTO ding_identities VALUES(?,?)',id,union);}
      if(b.role!==undefined) {row.role=choice(b.role,['admin','sales','pm'],'角色');if(u.role==='admin'&&row.role!=='admin')assert(one(db,"SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND business_member=1 AND developer_admin=0").n>1,'至少保留一名管理员');row.performance_enabled=row.role==='sales'?1:0;}
      if(b.performance_enabled!==undefined) {assert(typeof b.performance_enabled==='boolean','绩效标记无效');row.performance_enabled=b.performance_enabled?1:0;}
      const afterUser=row.ding_user_id===undefined?u.ding_user_id:row.ding_user_id;
      const afterUnion=one(db,'SELECT union_id FROM ding_identities WHERE user_id=?',id)?.union_id;
      assert(Boolean(afterUser)===Boolean(afterUnion),'钉钉绑定须同时提供已核验的userId和unionId');
      if(row.role==='pm'&&u.role!=='pm')assert(!one(db,'SELECT id FROM customers WHERE owner_id=? UNION ALL SELECT id FROM opportunities WHERE owner_id=? UNION ALL SELECT id FROM contracts WHERE owner_id=? LIMIT 1',id,id,id),'成员仍负责业务记录，须先移交后才能改为协作PM',409);
      if(Object.keys(row).length)update('users',id,row);run(db,'DELETE FROM sessions WHERE user_id=?',id);audit(actor,'更新成员权限映射','user',id,{fields:Object.keys(b)});return {id,message:'角色与钉钉映射已更新'};
    }
    assert(typeof b.active === "boolean", "成员状态无效");
    if (!b.active && u.role === "admin")
      assert(
        one(db, "SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND business_member=1 AND developer_admin=0")
          .n > 1,
        "至少保留一名管理员",
      );
    update("users", id, { active: b.active ? 1 : 0 });
    if (!b.active) run(db, "DELETE FROM sessions WHERE user_id=?", id);
    audit(actor, b.active ? "启用成员" : "停用成员", "user", id);
    return { message: "成员状态已更新" };
  }
}
