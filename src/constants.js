
// constants.js —— 全局常量（无语义、无依赖）
// 由 state/utils/budget/normalize/render-work 抽离（第六轮循环依赖治理），值不变。

const KEY='score_sys_v3';
const THEME_KEY='score_sys_theme';
const SCHEMA_VERSION=3;
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
const BUDGET_LEDGER_MAX=500;
const BUDGET_PERIOD_KEEP={week:13,month:12};
const AUDIT_MAX=50;
const STAGE_NAMES=['起步','训练','进步','突破','超常'];
const STAGE_PRESET_KEY='score_sys_stage_presets';
const BACKUP_KEY='score_sys_last_backup';
const LOG_MAX=300;
const LOG_DISPLAY=100;
const WEEK_ANCHOR_NAMES={1:'周一',2:'周二',3:'周三',4:'周四',5:'周五',6:'周六',7:'周日'};
const AFFAIR_CURVES={
  even:[10,20,30,40,50,60,70,80,90,100],
  lateHeavy:[2,5,10,17,26,37,50,65,82,100],
  earlyHeavy:[20,36,50,62,72,80,86,91,95,100],
  allAtEnd:[0,0,0,0,0,0,0,0,0,100]
};
const AFFAIR_CURVE_NAMES={even:'平均',lateHeavy:'后重',earlyHeavy:'前重',allAtEnd:'全押后',custom:'自定义'};
const COND_METRIC_KEYS=['checkins','vitality','progress','achievement','new_tasks','new_domains','budget_entry_amount','budget_period_spent','budget_period_overspend','budget_entry_count',
  // 阶段 1：项目 / 杂事 / 任务不活跃
  'affair_completed','affair_steps','affair_stall','affair_progress','affair_achievement',
  'chore_completed','chore_overdue','chore_decay','chore_batches','chore_idle','task_idle',
  // 阶段 3：商品门槛通用条件
  'lifetime_achievement','domain_activity','milestone_unlocked','checkin_streak','budget_remaining'];
const COND_POINT_METRICS=['affair_stall','chore_overdue','chore_idle','task_idle',
  'lifetime_achievement','milestone_unlocked','checkin_streak','budget_remaining'];
const COND_AFFAIR_METRICS=['affair_completed','affair_steps','affair_stall','affair_progress','affair_achievement'];
const COND_CHORE_METRICS=['chore_completed','chore_overdue','chore_decay','chore_batches','chore_idle'];
const COND_GATE_METRICS=['lifetime_achievement','domain_activity','milestone_unlocked','checkin_streak','budget_remaining'];
const COND_RANGES=[
  {v:'period',n:'本周期'},
  {v:'total',n:'累计'},
  {v:'recent',n:'最近N天'},
  {v:'today',n:'今天'}
];

export { KEY, THEME_KEY, SCHEMA_VERSION, PROD_TIERS, PROD_TIER_NAMES, ACTIVITY_MAX_DAYS, STATS_VERSION, STATS_KEEP_DAYS, STATS_ENTITY_MAPS, STATS_SCALARS, SHADOW_MAX, ACH_EARN_SOURCES, BUDGET_VERSION, BUDGET_RULE_KINDS, BUDGET_RULE_NAMES, BUDGET_TARGET_NAMES, BUDGET_LEDGER_MAX, BUDGET_PERIOD_KEEP, AUDIT_MAX, STAGE_NAMES, STAGE_PRESET_KEY, BACKUP_KEY, LOG_MAX, LOG_DISPLAY, WEEK_ANCHOR_NAMES, AFFAIR_CURVES, AFFAIR_CURVE_NAMES, COND_METRIC_KEYS, COND_POINT_METRICS, COND_AFFAIR_METRICS, COND_CHORE_METRICS, COND_GATE_METRICS, COND_RANGES };
