import { all, run, transaction } from "./database.mjs";
import { now, today, dateAdd, quarter } from "./domain.mjs";
export function seedDemo(db) {
  if (all(db, "SELECT id FROM users LIMIT 1").length) return false;
  transaction(db, () => {
    run(
      db,
      "INSERT OR REPLACE INTO settings VALUES(?,?)",
      "workspace_mode",
      "demo",
    );
    const insert = (table, row) => {
      const keys = Object.keys(row);
      return Number(
        run(
          db,
          `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          ...Object.values(row),
        ).lastInsertRowid,
      );
    };
    [
      ["演示管理员", "wanghong", "admin"],
      ["销售甲", "zhutian", "sales"],
      ["销售乙", "mili", "sales"],
    ].forEach(([name, username, role]) =>
      insert("users", { name, username, role, created_at: now() }),
    );
    const companies = [
      ["青禾农业科技（演示）", "青禾农业", "农牧科技", "广西", "A", 2, "成交"],
      ["北辰智能制造（演示）", "北辰制造", "智能制造", "广东", "A", 3, "成交"],
      ["云山建设集团（演示）", "云山建设", "建筑工程", "广东", "A", 2, "潜在"],
      ["启明教育集团（演示）", "启明教育", "教育", "江苏", "B", 3, "潜在"],
      ["远航物流（演示）", "远航物流", "物流运输", "湖北", "A", 2, "潜在"],
      ["新材科技（演示）", "新材科技", "新材料", "浙江", "B", 2, "潜在"],
      ["百川连锁（演示）", "百川连锁", "零售连锁", "广东", "B", 3, "潜在"],
      ["山海文旅（演示）", "山海文旅", "文化旅游", "海南", "C", 2, "潜在"],
      ["康宁器械（演示）", "康宁器械", "医疗器械", "上海", "C", 3, "流失"],
    ];
    companies.forEach(
      ([name, short_name, industry, region, level, owner_id, status], i) =>
        insert("customers", {
          name,
          normalized: name,
          short_name,
          industry,
          region,
          level,
          owner_id,
          status,
          scale: i % 2 ? "500–1000人" : "1000–5000人",
          note: "虚构演示客户，仅用于功能测试。",
          created_at: dateAdd(-25 + i) + "T02:00:00Z",
          updated_at: now(),
        }),
    );
    [
      [1, "杨总", "董事长", "决策人", "支持"],
      [1, "李经理", "IT负责人", "影响者", "支持"],
      [2, "周总", "总经理", "决策人", "中立"],
      [3, "陈主任", "信息中心主任", "影响者", "中立"],
      [5, "黄总", "CIO", "决策人", "支持"],
      [7, "刘店长", "运营总监", "把关人", "中立"],
    ].forEach(([customer_id, name, title, role, attitude]) =>
      insert("contacts", {
        customer_id,
        name,
        title,
        role,
        attitude,
        phone: "",
        note: "示例联系人",
      }),
    );
    const opps = [
      [
        "协同办公平台升级",
        3,
        2,
        "商务谈判",
        180000,
        "标品",
        "确认采购条款，约定合同签署时间",
        -2,
        9,
        10,
      ],
      [
        "IDaaS 统一身份建设",
        5,
        2,
        "报价",
        220000,
        "标品",
        "回访报价，确认账号与系统接入范围",
        0,
        3,
        15,
      ],
      [
        "招生管理系统建设",
        4,
        3,
        "方案沟通",
        90000,
        "实施",
        "与教务负责人确认流程与验收范围",
        -1,
        7,
        20,
      ],
      [
        "钉钉旗舰版 POC",
        6,
        2,
        "POC 试用",
        150000,
        "标品",
        "核对试用反馈，确认关键场景验收结果",
        -3,
        13,
        8,
      ],
      [
        "二期数据平台建设",
        2,
        3,
        "需求确认",
        300000,
        "实施",
        "访谈业务负责人，形成首批指标清单",
        1,
        1,
        35,
      ],
      [
        "门店数字化协同",
        7,
        3,
        "初步接触",
        60000,
        "标品",
        "约定门店运营场景沟通时间",
        0,
        3,
        40,
      ],
      [
        "审批工作流实施",
        5,
        2,
        "需求确认",
        80000,
        "实施",
        "梳理审批流程，请业务部门确认",
        3,
        2,
        30,
      ],
      [
        "会员运营系统",
        8,
        2,
        "线索",
        30000,
        "实施",
        "确认预算与决策链，判断项目投入",
        2,
        4,
        45,
      ],
      [
        "企业版席位扩容与实施",
        1,
        2,
        "成交",
        517000,
        "混合",
        "完成验收并跟进实施尾款",
        5,
        12,
        -12,
      ],
      [
        "AI 质检标准包与集成",
        2,
        3,
        "成交",
        380000,
        "混合",
        "确认尾款到账时间",
        -1,
        6,
        -6,
      ],
      [
        "办公套件采购",
        9,
        3,
        "流失",
        45000,
        "标品",
        "记录流失原因，保留后续联系",
        null,
        20,
        -20,
      ],
      [
        "协同平台续费评估",
        1,
        2,
        "方案沟通",
        128000,
        "标品",
        "对齐续费席位与服务周期",
        4,
        2,
        25,
      ],
    ];
    opps.forEach(
      (
        [
          name,
          customer_id,
          owner_id,
          stage,
          amount,
          product_type,
          next_action,
          follow,
          stageDays,
          expected,
        ],
        i,
      ) => {
        const id = insert("opportunities", {
          name,
          customer_id,
          owner_id,
          stage,
          amount: amount * 100,
          product_type,
          next_action,
          follow_date: follow === null ? null : dateAdd(follow),
          expected_date: dateAdd(expected),
          stage_at: dateAdd(-stageDays) + "T02:00:00Z",
          source: i % 3 === 0 ? "分发" : "自建",
          nature: i === 11 ? "续签" : "新签",
          lost_reason: stage === "流失" ? "预算调整，暂停采购" : "",
          created_at: dateAdd(-Math.min(20, i + 3)) + "T02:00:00Z",
          updated_at: now(),
        });
        insert("activities", {
          opportunity_id: id,
          user_id: owner_id,
          source: i % 3 === 0 ? "现场拜访" : "手动跟进",
          activity_type: i % 3 === 0 ? "现场拜访" : "手动跟进",
          summary: [
            "客户已反馈合同条款，采购流程仍需确认。",
            "已向客户讲解报价方案，等待确认接入范围。",
            "初步方案已沟通，下一轮需补齐验收口径。",
            "试用进入反馈阶段，需要汇总关键用户意见。",
            "需求清单已初步梳理，待业务负责人确认。",
          ][i % 5],
          action: next_action,
          activity_date: dateAdd(-i % 4),
          created_at: dateAdd(-i % 4) + "T03:20:00Z",
        });
      },
    );
    [2, 3, 4].forEach((id, i) =>
      insert("quotes", {
        opportunity_id: id,
        user_id: id === 3 ? 3 : 2,
        amount: [22000000, 9000000, 15000000][i],
        valid_until: dateAdd(12),
        note: "示例报价记录，正式模板待提供。",
        created_at: dateAdd(-3) + "T02:00:00Z",
      }),
    );
    [
      [9, 1, 2, "企业版席位扩容与实施", 517000, "交付中", -12, 353],
      [10, 2, 3, "AI 质检标准包与集成", 380000, "待验收", -6, 359],
    ].forEach(
      ([
        opportunity_id,
        customer_id,
        owner_id,
        name,
        amount,
        accept_status,
        sign,
        valid,
      ]) => {
        const cid = insert("contracts", {
          opportunity_id,
          customer_id,
          owner_id,
          name,
          amount: amount * 100,
          sign_date: dateAdd(sign),
          valid_until: dateAdd(valid),
          scope: name,
          accept_status,
          created_at: dateAdd(sign) + "T02:00:00Z",
        });
        const lines =
          cid === 1
            ? [
                ["企业版席位授权", "标品", 357000, 0.45],
                ["宜搭定制实施", "实施", 160000, 0.5],
              ]
            : [
                ["AI 质检标准包", "标品", 260000, 0.45],
                ["系统集成实施", "实施", 120000, 0.5],
              ];
        lines.forEach(([name, kind, amount, rate]) =>
          insert("contract_items", {
            contract_id: cid,
            name,
            kind,
            amount: amount * 100,
            rate,
            margin: Math.round(amount * 100 * rate),
            payment_date: dateAdd(sign + 1),
            valid_until: dateAdd(valid),
          }),
        );
        insert("payments", {
          contract_id: cid,
          amount: (cid === 1 ? 437000 : 260000) * 100,
          status: "已到账",
          pay_date: dateAdd(-5),
          promise_date: dateAdd(-5),
          note: "示例到账记录",
          created_at: dateAdd(-5) + "T03:00:00Z",
        });
        insert("payments", {
          contract_id: cid,
          amount: (cid === 1 ? 80000 : 120000) * 100,
          status: cid === 1 ? "待到账" : "逾期",
          promise_date: dateAdd(cid === 1 ? 10 : -1),
          note: "实施验收尾款",
          created_at: dateAdd(-5) + "T03:00:00Z",
        });
      },
    );
    [2, 3].forEach((user_id) =>
      insert("targets", { user_id, quarter: quarter(), amount: 150000000 }),
    );
    insert("audit", {
      user_id: 1,
      action: "初始化演示工作区",
      entity: "system",
      detail: '{"demo":true}',
      created_at: now(),
    });
  });
  return true;
}
