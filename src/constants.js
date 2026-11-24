
// constants.js —— 全局常量（无语义、无依赖）
// 由 state/utils/budget/normalize/render-work 抽离（第六轮循环依赖治理），值不变。

const KEY='score_sys_v3';
const THEME_KEY='score_sys_theme';
const SCHEMA_VERSION=4;
// 阶段 4：资产定义 / 动作流的子结构版本，与全局 schema.v 解耦（纯加字段不升子版本）
const ASSET_VERSION=1;
const FLOW_VERSION=1;
const FLOW_MAX_STEPS=32;
const FLOW_MAX_DEPTH=3;
const FLOW_RUN_KEEP=50;
// 幂等键保留条数：只影响历史去重，不影响当期判定
const FLOW_IDEM_KEEP=200;
// 阶段 4 动作原子：单步硬上限（与流级总额、资产定义上限叠加，取更严格者）
const FLOW_ATOM_MAX_CURRENCY=100;
const FLOW_ATOM_MAX_ASSET=10;
const FLOW_ATOM_MAX_ARCHIVE=20;
const FLOW_ATOM_MAX_NOTES=10;
const FLOW_ATOM_NOTE_MAX_LEN=120;
const FLOW_ATOM_IDLE_DAYS_MAX=365;
// 按模板创建事项：单次上限（不允许无上限批量生成）
const FLOW_ATOM_MAX_CREATE=5;
const FLOW_ATOM_CREATE_NAME_MAX=30;
// 执行权商品：每个周期最多可购买的次数上限
const PRODUCT_EXEC_MAX_PER_PERIOD=10;
// 阶段 5：事件触发（打卡/购买已在提交后接通；深度与单事件上限为硬约束，不随配置上调）
const EVENT_KEEP=50;
const EVENT_MAX_FLOWS_PER_EVENT=20;
const EVENT_DEPTH_MAX=1;
const PROD_TIERS=['daily','quality','exclusive'];
const PROD_TIER_NAMES={daily:'日常级',quality:'品质级',exclusive:'专属级'};
const ACTIVITY_MAX_DAYS=90;
const STATS_VERSION=2;
const STATS_KEEP_DAYS=400;
const STATS_ENTITY_MAPS=['vd','pd','vt','pt','ct','cd'];
const STATS_SCALARS=['v','p','a','ck','inv','cons','prod'];
const SHADOW_MAX=200;
const ACH_EARN_SOURCES={achievement:true,reward:true,affair:true,'budget-reward':true};
const BUDGET_VERSION=3;
const BUDGET_RULE_KINDS=['penalty','reward','feedback'];
const BUDGET_RULE_NAMES={penalty:'超支惩罚',reward:'结余奖励',feedback:'消费反哺'};
const BUDGET_TARGET_NAMES={vitality:'活力点',achievement:'成果点',progress:'进度值'};
// 现实钱币种表（只读）：代码 → 显示符号/名称。无汇率、无状态；预算分类只存代码。
// 与虚拟积分（vitality/achievement/progress）及扩容花费币种（cat.overdraft.currency）无关。
// 符号带前缀（US$/HK$/NT$…）避免各系统字体下 $ 歧义。
const CURRENCIES={
  CNY:{symbol:'¥',name:'人民币'},
  USD:{symbol:'US$',name:'美元'},
  EUR:{symbol:'€',name:'欧元'},
  JPY:{symbol:'JP¥',name:'日元'},
  GBP:{symbol:'£',name:'英镑'},
  HKD:{symbol:'HK$',name:'港币'},
  TWD:{symbol:'NT$',name:'新台币'},
  KRW:{symbol:'₩',name:'韩元'},
  SGD:{symbol:'S$',name:'新加坡元'},
  AUD:{symbol:'A$',name:'澳元'},
  CAD:{symbol:'C$',name:'加元'}
};
const BUDGET_LEDGER_MAX=500;
const BUDGET_PERIOD_KEEP={week:13,month:12};
// 杂事标签：纯文本、独立于领域；超出条数/长度的条目直接丢弃（不截断、不迁移）
const CHORE_TAG_MAX_COUNT=6;
const CHORE_TAG_MAX_LEN=12;
const AUDIT_MAX=50;
const STAGE_NAMES=['起步','训练','进步','突破','超常'];
const STAGE_PRESET_KEY='score_sys_stage_presets';
const BACKUP_KEY='score_sys_last_backup';
const LOG_MAX=300;
const LOG_DISPLAY=100;
// 撤销留痕：旁挂副本只用于流水面板灰显，独立于主账本；
// 上限刻意远小于 LOG_MAX，且不参与 LOG_MAX 的容量计算，避免变相扩大日志容量。
const REVERSED_LOG_KEEP=100;
const WEEK_ANCHOR_NAMES={1:'周一',2:'周二',3:'周三',4:'周四',5:'周五',6:'周六',7:'周日'};
const AFFAIR_CURVES={
  even:[10,20,30,40,50,60,70,80,90,100],
  lateHeavy:[2,5,10,17,26,37,50,65,82,100],
  earlyHeavy:[20,36,50,62,72,80,86,91,95,100],
  allAtEnd:[0,0,0,0,0,0,0,0,0,100]
};
const COND_METRIC_KEYS=['checkins','vitality','progress','achievement','new_tasks','new_domains','budget_entry_amount','budget_period_spent','budget_period_overspend','budget_entry_count',
  // 阶段 1：项目 / 杂事 / 任务不活跃
  'affair_completed','affair_steps','affair_stall','affair_progress','affair_achievement',
  // 单实体条件（D1）：只对 targetType:'entity' 有意义
  'affair_cell','chore_overdue_days','chore_cycle_due_in',
  'chore_completed','chore_overdue','chore_decay','chore_batches','chore_idle','task_idle',
  // 情境指标：超期为点态，完成数为窗口（与 chore_completed 同口径）
  'chore_tag_overdue','chore_tag_completed',
  // 阶段 3：商品门槛通用条件
  'lifetime_achievement','domain_activity','milestone_unlocked','checkin_streak','budget_remaining',
  // 阶段 6：自定义资产（持有 / 本期发放 / 本期消耗）
  'asset_hold','asset_issued','asset_spent'];
// 资产指标：主体固定为「某一份资产」；asset_hold 在事件发生时刻即为确定值，
// 因此不放进 COND_POINT_METRICS（避免被事件触发的点态指标禁用规则误伤）。
const COND_ASSET_METRICS=['asset_hold','asset_issued','asset_spent'];
const ASSET_LOG_CATS=['issue','spend','expire','freeze','unfreeze','adjust'];
const ASSET_LOG_CAT_NAMES={issue:'发放',spend:'消耗',expire:'过期',freeze:'冻结',unfreeze:'解冻',adjust:'手动调整'};
const COND_POINT_METRICS=['affair_stall','chore_overdue','chore_idle','task_idle','chore_tag_overdue',
  'affair_cell','chore_overdue_days','chore_cycle_due_in',
  'lifetime_achievement','milestone_unlocked','checkin_streak','budget_remaining'];
const COND_AFFAIR_METRICS=['affair_completed','affair_steps','affair_stall','affair_progress','affair_achievement','affair_cell'];
const COND_CHORE_METRICS=['chore_completed','chore_overdue','chore_decay','chore_batches','chore_idle','chore_tag_overdue','chore_tag_completed','chore_overdue_days','chore_cycle_due_in'];
// 单实体目标（D1）：首批只允许项目 / 杂事。target 存 'kind:id'。
const COND_ENTITY_KINDS=['affair','chore'];
const COND_ENTITY_METRICS={
  affair:['affair_cell','affair_steps','affair_stall','affair_progress','affair_completed'],
  chore:['chore_completed','chore_overdue_days','chore_idle','chore_cycle_due_in']
};
// 实体条件下哪些指标是点态：事件触发编译期据此拒绝（window 型仍可编译）。
const COND_ENTITY_POINT_METRICS=['affair_cell','affair_stall','affair_progress','chore_overdue_days','chore_idle','chore_cycle_due_in'];
// 只在单实体目标下才有定义的指标（其余 affair_*/chore_* 仍保留聚合语义）。
const COND_ENTITY_ONLY_METRICS=['affair_cell','chore_overdue_days','chore_cycle_due_in'];
const COND_GATE_METRICS=['lifetime_achievement','domain_activity','milestone_unlocked','checkin_streak','budget_remaining'];
const COND_RANGES=[
  {v:'period',n:'本周期'},
  {v:'total',n:'累计'},
  {v:'recent',n:'最近N天'},
  {v:'today',n:'今天'}
];

export { KEY, THEME_KEY, SCHEMA_VERSION, CHORE_TAG_MAX_COUNT, CHORE_TAG_MAX_LEN, ASSET_VERSION, FLOW_VERSION, FLOW_MAX_STEPS, FLOW_MAX_DEPTH, FLOW_RUN_KEEP, FLOW_IDEM_KEEP, FLOW_ATOM_MAX_CURRENCY, FLOW_ATOM_MAX_ASSET, FLOW_ATOM_MAX_ARCHIVE, FLOW_ATOM_MAX_NOTES, FLOW_ATOM_NOTE_MAX_LEN, FLOW_ATOM_IDLE_DAYS_MAX, FLOW_ATOM_MAX_CREATE, FLOW_ATOM_CREATE_NAME_MAX, PRODUCT_EXEC_MAX_PER_PERIOD, EVENT_KEEP, EVENT_MAX_FLOWS_PER_EVENT, EVENT_DEPTH_MAX, PROD_TIERS, PROD_TIER_NAMES, ACTIVITY_MAX_DAYS, STATS_VERSION, STATS_KEEP_DAYS, STATS_ENTITY_MAPS, STATS_SCALARS, SHADOW_MAX, ACH_EARN_SOURCES, BUDGET_VERSION, BUDGET_RULE_KINDS, BUDGET_RULE_NAMES, BUDGET_TARGET_NAMES, CURRENCIES, BUDGET_LEDGER_MAX, BUDGET_PERIOD_KEEP, AUDIT_MAX, STAGE_NAMES, STAGE_PRESET_KEY, BACKUP_KEY, LOG_MAX, LOG_DISPLAY, REVERSED_LOG_KEEP, WEEK_ANCHOR_NAMES, AFFAIR_CURVES, COND_METRIC_KEYS, COND_ASSET_METRICS, ASSET_LOG_CATS, ASSET_LOG_CAT_NAMES, COND_POINT_METRICS, COND_AFFAIR_METRICS, COND_CHORE_METRICS, COND_GATE_METRICS, COND_RANGES, COND_ENTITY_KINDS, COND_ENTITY_METRICS, COND_ENTITY_POINT_METRICS, COND_ENTITY_ONLY_METRICS };
