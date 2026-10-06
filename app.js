'use strict';

// ===== State =====
const KEY='score_sys_v3';
const THEME_KEY='score_sys_theme';
let state=defaults();
let editCurrency='vitality';
let editTypes=['vitality'];
let condDraft={mode:'all',items:[]};
let condPanel={visible:false,kind:'metric',path:'',step:'range',range:'period',days:7,metric:'checkins',targetType:'all',newFilter:'none',target:'',aggregate:'sum'};

// ===== 阶段奖励 =====
const STAGE_NAMES=['起步','训练','进步','突破','超常'];
const STAGE_PRESET_KEY='score_sys_stage_presets';
const BACKUP_KEY='score_sys_last_backup';
let stagePresets=loadStagePresets();
let editStage={enabled:false,v:[],p:[],dirtyV:false,dirtyP:false,last:0};
function loadStagePresets(){
  const p={stepPct:50,decreasePct:100};
  try{
    const raw=localStorage.getItem(STAGE_PRESET_KEY);
    if(raw){const o=JSON.parse(raw);if(typeof o.stepPct==='number')p.stepPct=o.stepPct;if(typeof o.decreasePct==='number')p.decreasePct=o.decreasePct;}
  }catch(e){}
  return p;
}
function saveStagePresets(){try{localStorage.setItem(STAGE_PRESET_KEY,JSON.stringify(stagePresets));}catch(e){}}
function stageRewards(t){const sr=t&&t.stageRewards;return sr&&(Array.isArray(sr.v)||Array.isArray(sr.p))?sr:null;}
function taskIsStaged(t){return !!stageRewards(t);}
function stageValues(t,type){const sr=stageRewards(t);if(!sr)return null;const arr=type==='vitality'?sr.v:sr.p;return Array.isArray(arr)&&arr.length===5?arr:null;}
function stageSel(t){const sr=stageRewards(t);const l=sr&&typeof sr.last==='number'?sr.last:0;return Math.max(0,Math.min(9,Math.round(l)));}
function stageValueAt(t,type,cell){const v=stageValues(t,type);if(!v)return 0;if(cell>=9)return v[4]+(v[4]-v[3])/2;const i=cell>>1,rem=cell&1;return rem?(v[i]+v[i+1])/2:v[i];}
function stageCellLabel(cell){if(cell<=8&&cell%2===0)return STAGE_NAMES[cell/2];return STAGE_NAMES[Math.min(4,(cell-1)>>1)]+'+';}
function round2(v){return Math.round(v*100)/100;}
// 日志金额：both 型且两分值不同时用 amtV/amtP 分别表达，否则回退到单一 amt
function logAmt(l,type){
  if(type==='vitality'&&typeof l.amtV==='number')return l.amtV;
  if(type==='progress'&&typeof l.amtP==='number')return l.amtP;
  return l.amt;
}

// ===== Theme =====
function initTheme(){
  const saved=localStorage.getItem(THEME_KEY);
  const prefersDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme=saved||(prefersDark?'dark':'light');
  applyTheme(theme);
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme',theme);
  const btn=document.getElementById('themeToggle');
  if(btn)btn.textContent=theme==='dark'?'☀️':'🌙';
}
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme')||'light';
  const next=cur==='dark'?'light':'dark';
  localStorage.setItem(THEME_KEY,next);
  applyTheme(next);
  render();
}
initTheme();

function cardName(c){return c==='exemption'?'断更豁免卡':(c||'卡');}
const COND_METRIC_KEYS=['checkins','vitality','progress','achievement','new_tasks','new_domains'];
const COND_RANGES=[
  {v:'period',n:'本周期'},
  {v:'total',n:'累计'},
  {v:'recent',n:'最近N天'},
  {v:'today',n:'今天'}
];
function validRange(r){return r==='period'||r==='total'||r==='recent'||r==='today';}
function normOp(op){return ['>','<','<=','>='].indexOf(op)>=0?op:'>=';}
// 将旧数据中 target/domainId（仅指领域）迁移为 targetType/target；若已有合法 targetType 则保留
function applyCondTarget(o,it){
  const tt=it.targetType;
  // 迁移上一版 one-off 主体「本周期新增任务」→ 可组合结构
  if(tt==='new_task'){o.targetType='all';o.newFilter='new_task';o.aggregate='any';return;}
  if(tt==='task'&&it.target){o.targetType='task';o.target=it.target;}
  else if(tt==='domain'&&it.target){o.targetType='domain';o.target=it.target;}
  else if(tt==='domain'){o.targetType='domain';}
  else{o.targetType='all';}
  // 旧版 progress 的 target/domainId 实为领域
  if(it.metric==='progress'&&(it.target||it.domainId)){o.targetType='domain';o.target=it.domainId||it.target;}
  o.newFilter=(it.newFilter==='new_task'||it.newFilter==='new_domain')?it.newFilter:'none';
  o.aggregate=(it.aggregate==='any')?'any':'sum';
}
const COND_LEGACY_MAP={
  'progress_total':{metric:'progress',range:'total'},
  'progress_domain':{metric:'progress',range:'total'},
  'checkins_period':{metric:'checkins',range:'period'},
  'checkins_total':{metric:'checkins',range:'total'},
  'new_task_period':{metric:'new_tasks',range:'period'},
  'new_domain_period':{metric:'new_domains',range:'period'}
};
function defaultActivities(){
  return[
    {id:'act_exemption',name:'断更豁免卡',enabled:true,period:'week',anchor:1,
     condition:{mode:'all',items:[]},
     result:{items:[{type:'card',card:'exemption',amount:1,cap:3}]},lastRun:null},
    {id:'act_score_up',name:'进步奖励',enabled:false,period:'week',anchor:1,
     condition:{mode:'all',items:[{range:'period',metric:'checkins',op:'>=',value:3}]},
     result:{items:[{type:'vitality',amount:10}]},lastRun:null}
  ];
}
function normalizeCondItem(it){
  if(!it)return null;
  // 1) New range leaf format
  if(validRange(it.range)){
    if(COND_METRIC_KEYS.indexOf(it.metric)<0)return null;
    const o={range:it.range,metric:it.metric,op:normOp(it.op),value:Number(it.value)||0};
    if(it.range==='recent')o.days=Math.max(1,Math.round(Number(it.days)||7));
    applyCondTarget(o,it);
    return o;
  }
  // 2) Previous 5-field scope format (scope→range)
  if(COND_METRIC_KEYS.indexOf(it.metric)>=0){
    const range=it.scope==='total'?'total':'period';
    const o={range:range,metric:it.metric,op:normOp(it.op),value:Number(it.value)||0};
    applyCondTarget(o,it);
    return o;
  }
  // 3) Legacy metric-name migration
  const lm=COND_LEGACY_MAP[it.metric];
  if(!lm)return null;
  const o={range:lm.range,metric:lm.metric,op:normOp(it.op),value:Number(it.value)||0};
  applyCondTarget(o,it);
  return o;
}
function normalizeCondNode(node){
  if(node&&node.group)return {group:true,mode:node.mode==='any'?'any':'all',items:(node.items||[]).map(normalizeCondNode).filter(Boolean)};
  return normalizeCondItem(node);
}
function normalizeCondition(c){
  if(c&&Array.isArray(c.items))
    return {mode:c.mode==='any'?'any':'all',items:c.items.map(normalizeCondNode).filter(Boolean)};
  return {mode:'all',items:[]};
}
function normalizeRewardItem(it){
  if(!it)return null;
  if(it.type==='card')return {type:'card',card:it.card||'exemption',amount:Math.max(0,Math.round(it.amount||0)),cap:Math.max(1,Math.round(it.cap||3))};
  if(it.type==='progress'){
    const r={type:'progress',amount:Number(it.amount)||0};
    if(it.domainId)r.domainId=it.domainId;
    return r;
  }
  if(it.type==='vitality'){
    const r={type:'vitality',amount:Number(it.amount)||0};
    if(it.taskId)r.taskId=it.taskId;
    return r;
  }
  if(it.type==='achievement')return {type:'achievement',amount:Number(it.amount)||0};
  return null;
}
function normalizeResult(r){
  r=r||{};
  if(Array.isArray(r.items))return {items:r.items.map(normalizeRewardItem).filter(Boolean)};
  if(r.type==='grant_cards')
    return {items:[{type:'card',card:r.card||'exemption',amount:Math.max(0,Math.round(r.amount||0)),cap:Math.max(1,Math.round(r.cap||3))}]};
  if(r.type==='grant_points'){
    const items=(r.items||[]).map(it=>{
      if(it.currency==='vitality')return {type:'vitality',amount:Number(it.amount)||0};
      if(it.currency==='progress')return {type:'progress',domainId:it.domainId||'d_default',amount:Number(it.amount)||0};
      if(it.currency==='achievement')return {type:'achievement',amount:Number(it.amount)||0};
      return null;
    }).filter(Boolean);
    return {items:items};
  }
  return {items:[]};
}
function normalizeActivity(a){
  return{
    id:a.id||uid(),name:a.name||'未命名活动',enabled:a.enabled!==false,
    period:a.period||'week',anchor:a.anchor||1,
    condition:normalizeCondition(a.condition),
    result:normalizeResult(a.result),
    lastRun:a.lastRun||null
  };
}
function migrateActivities(p){
  if(Array.isArray(p.activities))return p.activities.map(normalizeActivity);
  const defs=defaultActivities().map(normalizeActivity);
  const ex=defs.find(a=>(a.result.items||[]).some(it=>it.type==='card'&&it.card==='exemption'));
  const oldEx=(p.rules&&p.rules.exemption)||null;
  if(ex&&oldEx){
    const cardItem=(ex.result.items||[]).find(it=>it.type==='card'&&it.card==='exemption');
    if(cardItem){
      ex.enabled=oldEx.enabled!==false;
      ex.period=oldEx.period||'week';
      ex.anchor=oldEx.anchor||1;
      cardItem.amount=Math.max(0,Math.round(oldEx.amount||0));
      cardItem.cap=Math.max(1,Math.round(oldEx.cap||1));
    }
    if(p.ruleLastRun&&p.ruleLastRun.exemption)ex.lastRun=p.ruleLastRun.exemption;
  }
  return defs;
}
function defaults(){
  return{
    scores:{vitality:0,progress:{},achievement:0},
    domains:[{id:'d_default',name:'默认'}],
    collections:[{id:'c_default',name:'默认'}],
    shopCategories:[{id:'sc_default',name:'默认'}],
    collapsedColls:[],
    collapsedAchDoms:[],
    collapsedShopCats:[],
    tasks:[],achievements:[],products:[],logs:[],
    loans:[],
    cards:{exemption:0},
    activities:defaultActivities(),
    lastDebtDate:null,
    filterDomain:null,
    metrics:[]
  };
}
let loadIssue=null;
// 尽力修复被截断/轻微损坏的 JSON（常见于 IndexedDB 写入中断）
function salvageJSON(raw){
  if(!raw||typeof raw!=='string')return null;
  try{return JSON.parse(raw);}catch(e){}
  try{return JSON.parse(raw.trim());}catch(e){}
  const s=raw.trim();
  if(s[0]==='{'){
    let depth=0,inStr=false,esc=false,end=-1;
    for(let i=0;i<s.length;i++){
      const ch=s[i];
      if(inStr){if(esc)esc=false;else if(ch==='\\')esc=true;else if(ch==='"')inStr=false;continue;}
      if(ch==='"'){inStr=true;continue;}
      if(ch==='{')depth++;
      else if(ch==='}'){depth--;if(depth===0){end=i;break;}}
    }
    if(end>0){
      try{return JSON.parse(s.slice(0,end+1));}catch(e){}
    }
  }
  return null;
}
function parseState(raw){
  if(!raw)return defaults();
  let p;
  try{
    p=JSON.parse(raw);
  }catch(e1){
    p=salvageJSON(raw);
    if(!p){loadIssue={type:'corrupt'};return defaults();}
    loadIssue={type:'salvaged'};
  }
  try{
    const tasks=(p.tasks||[]).map(t=>{
      // Migrate old single domainId to domainIds array
      if(t.domainIds===undefined){
        t.domainIds=t.domainId?[t.domainId]:['d_default'];
        delete t.domainId;
      }
      // Ensure description field exists
      if(t.description===undefined)t.description='';
      if(t.archived===undefined)t.archived=false;
      // Migrate single scoreType to scoreTypes array
      if(t.scoreTypes===undefined){
        t.scoreTypes=(t.scoreType==='progress')?['progress']:['vitality'];
        delete t.scoreType;
      }
      return t;
    });
    return{
      scores:p.scores||{vitality:0,progress:{},achievement:0},
      domains:p.domains||[{id:'d_default',name:'默认'}],
      collections:p.collections||[{id:'c_default',name:'默认'}],
      shopCategories:p.shopCategories||[{id:'sc_default',name:'默认'}],
      collapsedColls:p.collapsedColls||[],
      collapsedAchDoms:p.collapsedAchDoms||[],
      collapsedShopCats:p.collapsedShopCats||[],
      tasks:tasks,achievements:p.achievements||[],
      products:p.products||[],logs:p.logs||[],
      loans:p.loans||[],
      lastDebtDate:p.lastDebtDate||null,
      filterDomain:p.filterDomain||null,
      metrics:Array.isArray(p.metrics)?p.metrics:[],
      cards:Object.assign({exemption:0},p.cards||{}),
      activities:migrateActivities(p)
    };
  }catch(e){loadIssue={type:'corrupt'};return defaults();}
}

// ===== IndexedDB 持久化层 =====
const IDB_NAME='score_sys_db';
const IDB_VERSION=1;
const IDB_STORE='kv';
let _idbPromise=null;
function openIDB(){
  if(_idbPromise)return _idbPromise;
  _idbPromise=new Promise(function(resolve,reject){
    if(!window.indexedDB){reject(new Error('no-indexeddb'));return;}
    const req=indexedDB.open(IDB_NAME,IDB_VERSION);
    req.onupgradeneeded=function(e){
      const db=e.target.result;
      if(!db.objectStoreNames.contains(IDB_STORE))db.createObjectStore(IDB_STORE);
    };
    req.onsuccess=function(e){resolve(e.target.result);};
    req.onerror=function(e){reject(e.target.error);};
  });
  return _idbPromise;
}
// 仅保留主数据键；其余历史 key 见 migrateLegacy()
function idbGet(key){
  return openIDB().then(function(db){
    return new Promise(function(resolve,reject){
      const tx=db.transaction(IDB_STORE,'readonly');
      const rq=tx.objectStore(IDB_STORE).get(key);
      rq.onsuccess=function(){resolve(rq.result);};
      rq.onerror=function(){reject(rq.error);};
    });
  });
}
function idbPut(key,val){
  return openIDB().then(function(db){
    return new Promise(function(resolve,reject){
      const tx=db.transaction(IDB_STORE,'readwrite');
      tx.objectStore(IDB_STORE).put(val,key);
      tx.oncomplete=function(){resolve();};
      tx.onerror=function(){reject(tx.error);};
    });
  });
}

// save()：同步序列化当前 state，再串行写入 IndexedDB（异步落盘，调用方无需改动）
let _saveChain=Promise.resolve();
function save(){
  const json=JSON.stringify(state);
  _saveChain=_saveChain.then(function(){return idbPut(KEY,json);})
    .catch(function(e){console.warn('IndexedDB save failed',e);/* 写失败不阻塞 UI */});
}

// ===== Utils =====
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,5)}
function fmt(n){
  if(n===null||n===undefined||isNaN(n))return'0';
  const r=Math.round(n*100000)/100000;
  if(r===0){
    // Non-zero but too small for 5 decimal places — show more precision
    if(n>0)return parseFloat(n.toFixed(10)).toString();
    if(n<0)return parseFloat(n.toFixed(10)).toString();
    return'0';
  }
  if(Number.isInteger(r))return''+r;
  // Show up to 5 decimal places, trim trailing zeros
  return parseFloat(r.toFixed(5)).toString();
}
function now(){return Date.now()}
function daysSince(ts){return ts?(Date.now()-ts)/864e5:0}
function effectiveLastTs(task){return Math.max(task.lastCheckIn||0,task.lastExempt||0)}
function fmtTime(ts){
  if(!ts)return '从未';
  const d=new Date(ts),n=new Date(),diff=(n-d)/864e5;
  if(diff<1&&d.getDate()===n.getDate()&&d.getMonth()===n.getMonth())
    return '今天 '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  if(diff<2)return '昨天';
  if(diff<7)return Math.floor(diff)+'天前';
  return(d.getMonth()+1)+'/'+d.getDate();
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function totalProgress(){return Object.values(state.scores.progress||{}).reduce((s,v)=>s+v,0)}
function domainName(id){const d=state.domains.find(x=>x.id===id);return d?d.name:'未知'}
function taskNameLabel(id){const t=state.tasks.find(x=>x.id===id);return t?t.name:'未知'}
function collectionName(id){const c=state.collections.find(x=>x.id===id);return c?c.name:'未分类'}
function domainProgress(id){return(state.scores.progress[id])||(0)}
function metricValue(m){return (m.domainIds||[]).reduce((s,did)=>s+domainProgress(did),0)}

// Get domain IDs for a task — supports both new (domainIds array) and old (domainId string) format
function getTaskDomainIds(t){
  if(t.domainIds&&Array.isArray(t.domainIds)&&t.domainIds.length>0)return t.domainIds;
  if(t.domainId)return[t.domainId];
  return['d_default'];
}
function taskScoreTypes(t){
  if(t.scoreTypes&&Array.isArray(t.scoreTypes)&&t.scoreTypes.length>0)return t.scoreTypes;
  if(t.scoreType)return t.scoreType==='progress'?['progress']:['vitality'];
  return ['vitality'];
}
function taskHasType(t,type){return taskScoreTypes(t).indexOf(type)>=0;}
function logHasType(l,st){return l.st==='both'?(st==='vitality'||st==='progress'):l.st===st;}
function applyCheckinGain(log,mult){
  const types=log.st==='both'?['vitality','progress']:[log.st];
  types.forEach(st=>{
    const amt=logAmt(log,st);
    if(st==='vitality')state.scores.vitality=(state.scores.vitality||0)+mult*amt;
    else if(st==='progress'){
      let dids=(log.dom||'').split(',').filter(Boolean);
      if(dids.length===0&&log.taskId){const t=state.tasks.find(x=>x.id===log.taskId);if(t)dids=getTaskDomainIds(t);}
      if(dids.length===0)dids=['d_default'];
      const share=amt/dids.length;
      dids.forEach(did=>{state.scores.progress[did]=(state.scores.progress[did]||0)+mult*share;});
    }
  });
}

function addLog(st,amt,desc,src,domId,extra){
  const entry={id:uid(),time:now(),st:st,amt:amt,desc:desc,src:src||'',dom:domId||''};
  if(extra)Object.assign(entry,extra);
  state.logs.unshift(entry);
  if(state.logs.length>300)state.logs=state.logs.slice(0,300);
}

// ===== Cycle Engine (time periods & rules) =====
function dayKey(ts){
  const d=new Date(ts);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function weekStartKey(ts,anchor){
  const d=new Date(ts);d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1; // 1=Mon .. 7=Sun
  let diff=dow-(anchor||1);
  if(diff<0)diff+=7;
  return dayKey(d.getTime()-diff*864e5);
}
function periodKey(cfg,ts){
  if(cfg.period==='day')return dayKey(ts);
  if(cfg.period==='month'){const d=new Date(ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
  return weekStartKey(ts,cfg.anchor||1);
}
function weekStartTs(anchor,ts){
  const d=new Date(ts);d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1;
  let diff=dow-(anchor||1);
  if(diff<0)diff+=7;
  return d.getTime()-diff*864e5;
}
function weekScore(start,end){
  let vit=0,prog=0,ach=0,checkins=0,invest=0,consume=0;
  state.logs.forEach(l=>{
    if(l.time<start||l.time>=end)return;
    if(l.st==='both'){vit+=logAmt(l,'vitality');prog+=logAmt(l,'progress');}
    else if(l.st==='vitality')vit+=logAmt(l,'vitality');
    else if(l.st==='progress')prog+=logAmt(l,'progress');
    else if(l.st==='achievement')ach+=l.amt;
    if(l.src==='checkin')checkins++;
    if(l.src==='cost'&&l.amt<0)invest+=(-l.amt);
    else if(l.src==='purchase'&&l.st==='vitality'&&l.amt<0)consume+=(-l.amt);
  });
  const spend=invest+consume;
  const investRate=spend>0?invest/spend*100:0;
  const score=prog + vit*0.5 + ach*10 + checkins*2;
  return {vit:vit,prog:prog,ach:ach,checkins:checkins,invest:invest,consume:consume,investRate:investRate,score:score};
}
function exemptionActivity(){
  return (state.activities||[]).find(a=>a.enabled&&(a.result&&a.result.items||[]).some(it=>it.type==='card'&&it.card==='exemption'));
}
function dayStartTs(ts){const d=new Date(ts);d.setHours(0,0,0,0);return d.getTime();}
function prevPeriodRange(act,ts){
  if(act.period==='day'){const s=dayStartTs(ts);return {start:s-864e5,end:s};}
  if(act.period==='month'){const d=new Date(ts);const cur=new Date(d.getFullYear(),d.getMonth(),1).getTime();const prev=new Date(d.getFullYear(),d.getMonth()-1,1).getTime();return {start:prev,end:cur};}
  const cur=weekStartTs(act.anchor||1,ts);return {start:cur-7*864e5,end:cur};
}
function evalCondition(act,ts){
  const c=act.condition||{mode:'all',items:[]};
  return evalNode({group:true,mode:c.mode==='any'?'any':'all',items:c.items||[]},act,ts);
}
function evalNode(node,act,ts){
  if(node&&node.group&&Array.isArray(node.items)){
    const items=node.items;
    if(!items.length)return true;
    const res=items.map(n=>evalNode(n,act,ts));
    return node.mode==='any'?res.some(Boolean):res.every(Boolean);
  }
  return evalCondItem(node,act,ts);
}
// 日志所属领域 id（缺省时回退到其任务的领域）
function logDomainsOf(l){
  let dids=(l.dom||'').split(',').filter(Boolean);
  if(!dids.length&&l.taskId){
    const t=state.tasks.find(x=>x.id===l.taskId);
    if(t)dids=getTaskDomainIds(t);
  }
  return dids;
}
// 日志是否命中某主体（全部/领域/任务）
function logMatchesTarget(l,targetType,target){
  if(!targetType||targetType==='all'||!target)return true;
  if(targetType==='task')return l.taskId===target;
  if(targetType==='domain')return logDomainsOf(l).indexOf(target)>=0;
  return true;
}
// 任务/领域对象是否命中某主体
function taskMatchesTarget(t,targetType,target){
  if(!targetType||targetType==='all'||!target)return true;
  if(targetType==='task')return t.id===target;
  if(targetType==='domain')return getTaskDomainIds(t).indexOf(target)>=0;
  return true;
}
function domainMatchesTarget(d,targetType,target){
  if(!targetType||targetType==='all'||!target)return true;
  if(targetType==='domain')return d.id===target;
  return true;
}
function rangeStats(start,end,targetType,target){
  let vitality=0,achievement=0,progressTotal=0,checkins=0,newTasks=0,newDomains=0;
  const progressByDomain={};
  const progressByTask={};
  state.logs.forEach(l=>{
    if(l.time<start||l.time>=end)return;
    if(!logMatchesTarget(l,targetType,target))return;
    if(logHasType(l,'vitality'))vitality+=logAmt(l,'vitality');
    if(logHasType(l,'progress')){
      const pAmt=logAmt(l,'progress');
      progressTotal+=pAmt;
      const dids=logDomainsOf(l);
      if(dids.length){
        const share=pAmt/dids.length;
        dids.forEach(d=>{progressByDomain[d]=(progressByDomain[d]||0)+share;});
      }else{
        progressByDomain['d_default']=(progressByDomain['d_default']||0)+pAmt;
      }
      if(l.taskId)progressByTask[l.taskId]=(progressByTask[l.taskId]||0)+pAmt;
    }
    if(l.st==='achievement')achievement+=l.amt;
    if(l.src==='checkin')checkins++;
  });
  state.tasks.forEach(t=>{
    if(t.createdAt&&t.createdAt>=start&&t.createdAt<end&&taskMatchesTarget(t,targetType,target))newTasks++;
  });
  state.domains.forEach(d=>{
    if(d.createdAt&&d.createdAt>=start&&d.createdAt<end&&domainMatchesTarget(d,targetType,target))newDomains++;
  });
  return {vitality:vitality,achievement:achievement,progressTotal:progressTotal,progressByDomain:progressByDomain,progressByTask:progressByTask,checkins:checkins,newTasks:newTasks,newDomains:newDomains};
}
function opSatisfied(val,op,v){
  if(op==='>')return val>v;
  if(op==='<')return val<v;
  if(op==='<=')return val<=v;
  return val>=v;
}
// 单个任务在 [w.start,w.end) 窗口内的指标取值
function taskMetricValue(metric,taskId,w,range){
  if(metric==='checkins'&&range==='total'){
    const t=state.tasks.find(x=>x.id===taskId);
    return t?(t.checkInCount||0):0;
  }
  const st=rangeStats(w.start,w.end,'task',taskId);
  if(metric==='checkins')return st.checkins;
  if(metric==='progress')return st.progressByTask[taskId]||0;
  if(metric==='vitality')return st.vitality;
  return 0;
}
// 单个领域在 [w.start,w.end) 窗口内的指标取值
function domainMetricValue(metric,domainId,w,range){
  if(range==='total'){
    if(metric==='progress')return domainProgress(domainId);
    if(metric==='checkins')return state.tasks.filter(t=>getTaskDomainIds(t).indexOf(domainId)>=0).reduce((s,t)=>s+(t.checkInCount||0),0);
  }
  const st=rangeStats(w.start,w.end,'domain',domainId);
  if(metric==='checkins')return st.checkins;
  if(metric==='progress')return st.progressByDomain[domainId]||0;
  if(metric==='vitality')return st.vitality;
  return 0;
}
function condWindowByRange(range,act,ts,days){
  if(range==='today'){const s=dayStartTs(ts);return {start:s,end:s+864e5};}
  if(range==='recent'){const d=Math.max(1,Math.round(Number(days)||7));return {start:ts-d*864e5,end:ts};}
  return prevPeriodRange(act,ts);
}
// 值类指标（打卡/活力/进度）的可组合最小实体集合：主体 × 新增筛选
function condLeafEntities(it,w){
  const tt=it.targetType||'all';
  const target=it.target||'';
  const nf=it.newFilter||'none';
  if(nf==='new_domain'){
    let ds=state.domains.filter(d=>d.createdAt&&d.createdAt>=w.start&&d.createdAt<w.end);
    if(tt==='domain'&&target)ds=ds.filter(d=>d.id===target);
    return ds.map(d=>({kind:'domain',id:d.id}));
  }
  let tasks=nf==='new_task'
    ?state.tasks.filter(t=>t.createdAt&&t.createdAt>=w.start&&t.createdAt<w.end)
    :state.tasks.slice();
  if(tt==='task'&&target)tasks=tasks.filter(t=>t.id===target);
  else if(tt==='domain'&&target)tasks=tasks.filter(t=>getTaskDomainIds(t).indexOf(target)>=0);
  return tasks.map(t=>({kind:'task',id:t.id}));
}
function entityMetricValue(metric,entity,w,range){
  if(entity.kind==='task')return taskMetricValue(metric,entity.id,w,range);
  if(entity.kind==='domain')return domainMetricValue(metric,entity.id,w,range);
  return 0;
}
// 计数类指标：新增任务/新增领域数量（主体 all/domain）
function evalCountMetric(it,w){
  const v=Number(it.value)||0;
  const isDomain=(it.targetType==='domain');
  const target=it.target||'';
  let val;
  if(it.metric==='new_tasks'){
    if(isDomain)val=state.tasks.filter(t=>t.createdAt&&t.createdAt>=w.start&&t.createdAt<w.end&&getTaskDomainIds(t).indexOf(target)>=0).length;
    else val=state.tasks.filter(t=>t.createdAt&&t.createdAt>=w.start&&t.createdAt<w.end).length;
  }else{
    if(isDomain)val=state.domains.some(d=>d.id===target&&d.createdAt&&d.createdAt>=w.start&&d.createdAt<w.end)?1:0;
    else val=state.domains.filter(d=>d.createdAt&&d.createdAt>=w.start&&d.createdAt<w.end).length;
  }
  return opSatisfied(val,it.op,v);
}
function evalCondItem(it,act,ts){
  const v=Number(it.value)||0;
  const range=validRange(it.range)?it.range:(it.scope==='total'?'total':'period');
  const w=range==='total'?{start:0,end:ts+1}:condWindowByRange(range,act,ts,it.days);
  // 成果点：全局累计，无主体/新增/聚合概念
  if(it.metric==='achievement'){
    const val=range==='total'?(state.scores.achievement||0):rangeStats(w.start,w.end).achievement;
    return opSatisfied(val,it.op,v);
  }
  // 计数类指标：新增任务/新增领域数量
  if(it.metric==='new_tasks'||it.metric==='new_domains')return evalCountMetric(it,w);
  // 值类指标：主体 × 新增筛选 × 聚合。全局累计总和用累计字段（vitality 含无任务归属的日志），避免遗漏
  const isGlobalAll=(it.targetType||'all')==='all'&&(it.newFilter||'none')==='none'&&it.aggregate!=='any';
  if(isGlobalAll){
    let val;
    if(range==='total'){
      if(it.metric==='checkins')val=state.tasks.reduce((s,t)=>s+(t.checkInCount||0),0);
      else if(it.metric==='progress')val=totalProgress();
      else val=state.scores.vitality||0;
    }else{
      const st=rangeStats(w.start,w.end);
      val=it.metric==='checkins'?st.checkins:it.metric==='progress'?st.progressTotal:st.vitality;
    }
    return opSatisfied(val,it.op,v);
  }
  const entities=condLeafEntities(it,w);
  if(!entities.length)return false;
  const vals=entities.map(e=>entityMetricValue(it.metric,e,w,range));
  if(it.aggregate==='any')return vals.some(mv=>opSatisfied(mv,it.op,v));
  return opSatisfied(vals.reduce((s,x)=>s+x,0),it.op,v);
}
function applyResult(act,ts){
  const items=(act.result&&act.result.items)||[];
  let grantedAny=false;
  items.forEach(it=>{
    if(!it)return;
    if(it.type==='card'){
      const card=it.card||'exemption';
      const cap=Math.max(1,Math.round(it.cap||1));
      const amount=Math.max(0,Math.round(it.amount||0));
      const before=state.cards[card]||0;
      if(amount>0&&before<cap){
        const granted=Math.min(cap,before+amount)-before;
        state.cards[card]=before+granted;
        if(granted>0){addLog('',0,'周期活动「'+act.name+'」发放 '+granted+' 张'+cardName(card),'card-grant','',{actId:act.id,granted:granted});grantedAny=true;}
      }
    }else if(it.type==='progress'){
      const amt=Number(it.amount)||0;
      if(amt>0){
        if(it.domainId){
          state.scores.progress[it.domainId]=(state.scores.progress[it.domainId]||0)+amt;
          addLog('progress',amt,'「'+act.name+'」奖励 '+domainName(it.domainId)+' 进度','reward',it.domainId,{actId:act.id});
        }else{
          // No domain specified: distribute equally across all domains
          const dids=state.domains.map(d=>d.id);
          if(dids.length){
            const share=amt/dids.length;
            dids.forEach(did=>{
              state.scores.progress[did]=(state.scores.progress[did]||0)+share;
            });
          }
          addLog('progress',amt,'「'+act.name+'」奖励 进度（全领域）','reward','',{actId:act.id});
        }
        grantedAny=true;
      }
    }else if(it.type==='vitality'){
      const amt=Number(it.amount)||0;
      if(amt>0){
        state.scores.vitality=(state.scores.vitality||0)+amt;
        const tName=it.taskId?(state.tasks.find(t=>t.id===it.taskId)||{}).name:'';
        const lbl=tName?('「'+tName+'」活力'):'活力';
        addLog('vitality',amt,'「'+act.name+'」奖励 '+lbl+' +'+fmt(amt),'reward','',{actId:act.id,taskId:it.taskId||''});
        grantedAny=true;
      }
    }else if(it.type==='achievement'){
      const amt=Number(it.amount)||0;
      if(amt>0){
        state.scores.achievement=(state.scores.achievement||0)+amt;
        addLog('achievement',amt,'「'+act.name+'」奖励 成果 +'+fmt(amt),'reward','',{actId:act.id});
        grantedAny=true;
      }
    }
  });
  if(grantedAny)checkAchievements();
}
function processActivities(){
  if(!state.activities)state.activities=[];
  const ts=Date.now();
  let changed=false;
  state.activities.forEach(act=>{
    if(!act.enabled)return;
    const key=periodKey(act,ts);
    if(act.lastRun===key)return;
    if(evalCondition(act,ts))applyResult(act,ts);
    act.lastRun=key;
    changed=true;
  });
  if(changed)save();
}
var _lastTickDay=null;
function schedulerTick(){
  const d=dayKey(Date.now());
  if(_lastTickDay===null){_lastTickDay=d;return;}
  if(d===_lastTickDay)return;
  _lastTickDay=d;
  processActivities();
  processDailyTaskDebts();
  processMetabolism();
  processLoans();
  render();
}

// ===== Score Engine =====
function calcCheckIn(task){
  // Determine calendar-day gap since last check-in
  const isFirst=!task.lastCheckIn;
  let gapDays=0;
  if(!isFirst){
    const prev=new Date(effectiveLastTs(task));prev.setHours(0,0,0,0);
    const curr=new Date();curr.setHours(0,0,0,0);
    gapDays=Math.round((curr-prev)/864e5);
  }

  // Determine streak state
  let curStreak=task.streak||0;
  if(curStreak===0&&!isFirst)curStreak=1;
  
  let newStreak, broken=false;
  if(isFirst){
    newStreak=1;                       // first ever check-in
  }else if(gapDays<=0){
    newStreak=curStreak;               // same day — streak unchanged
  }else if(gapDays===1){
    newStreak=curStreak+1;             // consecutive next day — streak grows
  }else{
    newStreak=1; broken=true;          // gap ≥ 2 — streak resets
  }

  // Interest bonus: grows with consecutive-day streak
  const bonus=task.initialValue*(task.interestRate/100)*Math.max(0,newStreak-1);
  const gross=task.initialValue+bonus;

  // Debt: subtract accumulated pendingDebt from the earnable amount.
  // If net goes negative, the excess is deducted from total scores at check-in.
  const pendingDebt=task.pendingDebt||0;
  const net=gross-pendingDebt;

  return{gross:gross,bonus:bonus,debt:pendingDebt,net:net,gapDays:gapDays,newStreak:newStreak,broken:broken,isFirst:isFirst,curStreak:curStreak};
}

// Calculate what happens if the user does NOT check in today
// Shows the pending debt that will reduce next check-in's earnable amount
function calcSkip(task){
  const isFirst=!task.lastCheckIn;
  let gapDays=0;
  if(!isFirst){
    const prev=new Date(effectiveLastTs(task));prev.setHours(0,0,0,0);
    const curr=new Date();curr.setHours(0,0,0,0);
    gapDays=Math.round((curr-prev)/864e5);
  }

  // If first check-in or same day, skipping today has no penalty yet
  if(isFirst||gapDays<=0){
    return{debt:0,gapAfterSkip:1,desc:'今日未打卡，明日开始累积待扣债'};
  }

  const gapAfterSkip=gapDays+1;
  const dailyDebt=task.initialValue*(task.debtRate/100);
  const currentPending=task.pendingDebt||0;

  if(gapDays===1){
    // Checked in yesterday, skipping today → tomorrow gap=2, first debt day
    if(task.debtRate>0){
      const tomorrowPending=currentPending+dailyDebt;
      return{debt:dailyDebt,gapAfterSkip:gapAfterSkip,desc:'今日不打卡，明日待扣债+'+fmt(dailyDebt)+' (累计'+fmt(tomorrowPending)+')'};
    }else{
      return{debt:0,gapAfterSkip:gapAfterSkip,desc:'今日不打卡，连胜中断'};
    }
  }else{
    // Already in debt period (gap >= 2), another day adds more
    if(task.debtRate>0){
      const tomorrowPending=currentPending+dailyDebt;
      return{debt:dailyDebt,gapAfterSkip:gapAfterSkip,desc:'已断更'+(gapDays-1)+'天，明日待扣债+'+fmt(dailyDebt)+' (累计'+fmt(tomorrowPending)+')'};
    }else{
      return{debt:0,gapAfterSkip:gapAfterSkip,desc:'已断更'+(gapDays-1)+'天'};
    }
  }
}

function checkIn(taskId,stageIdx){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!t)return;
  if(t.archived){toast('该任务已归档，请先解锁','err');return}
  const types=taskScoreTypes(t);
  const hasV=types.indexOf('vitality')>=0;
  const hasP=types.indexOf('progress')>=0;
  const name=hasV&&hasP?'活力点+进度值':(hasP?'进度值':'活力点');
  const st=hasV&&hasP?'both':(hasP?'progress':'vitality');
  const cost=t.vitalityCost||0;

  // streak 由 calcCheckIn 计算（各档位共享同一连击）
  const c=calcCheckIn(t);
  const staged=taskIsStaged(t);

  // 阶段任务按选中档位结算；否则保持单档结算（初始值 + 连胜 - 债务）
  let netV=0,netP=0,stageName=null;
  if(staged){
    const cell=(typeof stageIdx==='number')?Math.max(0,Math.min(9,Math.round(stageIdx))):stageSel(t);
    if(t.stageRewards)t.stageRewards.last=cell;
    netV=hasV?stageValueAt(t,'vitality',cell):0;
    netP=hasP?stageValueAt(t,'progress',cell):0;
    stageName=stageCellLabel(cell);
  }else{
    netV=hasV?c.net:0;
    netP=hasP?c.net:0;
  }

  // Allow check-in even with insufficient vitality (goes negative, consistent with loan system)
  if(cost>0&&state.scores.vitality<cost){
    toast('活力点不足，将进入负值（贷款）','warn');
  }

  // Save previous state for undo
  const prevStreak=t.streak||0;
  const prevLastCheckIn=t.lastCheckIn||null;
  const prevLastDebtDate=t.lastDebtDate||null;
  const prevPendingDebt=t.pendingDebt||0;

  // Create the check-in log entry ID first so cost log can link to it
  const checkinLogId=uid();

  // Deduct vitality cost (linked to the check-in log for undo)
  if(cost>0){
    state.scores.vitality-=cost;
    addLog('vitality',-cost,'「'+t.name+'」消耗活力点','cost','',{taskId:t.id,link:checkinLogId});
  }

  const dids=getTaskDomainIds(t);
  if(hasV)state.scores.vitality+=netV;
  if(hasP){
    // Distribute progress equally across all task domains
    const share=netP/dids.length;
    dids.forEach(did=>{
      state.scores.progress[did]=(state.scores.progress[did]||0)+share;
    });
  }
  t.lastCheckIn=now();
  t.checkInCount=(t.checkInCount||0)+1;
  t.totalEarned=(t.totalEarned||0)+(hasP?netP:netV);
  t.streak=c.newStreak;
  delete t.lastDebtDate; // reset daily debt tracking after check-in
  t.pendingDebt=0; // clear accumulated debt after check-in

  let desc='「'+t.name+'」打卡';
  if(staged&&stageName){
    desc+=' · '+stageName;
    if(hasV&&hasP)desc+=' (活力+'+fmt(netV)+' / 进度+'+fmt(netP)+')';
    else desc+=' (+'+fmt(hasP?netP:netV)+')';
  }else{
    if(c.bonus>0)desc+=' (连胜'+c.newStreak+'天 +'+fmt(c.bonus)+')';
    if(c.debt>0)desc+=' (抵扣待扣债-'+fmt(c.debt)+')';
  }
  if(cost>0)desc+=' (消耗活力-'+fmt(cost)+')';

  // Manually insert with known ID for linking, plus undo metadata
  const entry={id:checkinLogId,time:now(),st:st,amt:0,desc:desc,src:'checkin',dom:dids.join(','),taskId:t.id,prevStreak:prevStreak,prevLastCheckIn:prevLastCheckIn,prevLastDebtDate:prevLastDebtDate,prevPendingDebt:prevPendingDebt};
  if(hasV&&hasP&&netV!==netP){
    entry.amtV=netV;entry.amtP=netP;entry.amt=netV;
  }else{
    entry.amt=hasP?netP:netV;
  }
  state.logs.unshift(entry);
  if(state.logs.length>300)state.logs=state.logs.slice(0,300);

  save();
  if(hasP){
    dids.forEach(did=>checkAchievements(did));
  }
  processDailyTaskDebts();
  processLoans();

  let toastMsg;
  if(staged&&stageName){
    if(hasV&&hasP)toastMsg=t.name+' '+stageName+' +'+fmt(netV)+'活力 / +'+fmt(netP)+'进度';
    else toastMsg=t.name+' '+stageName+' +'+fmt(hasP?netP:netV)+' '+name;
  }else{
    const sign=c.net>=0?'+':'';
    toastMsg=t.name+' '+sign+fmt(c.net)+' '+name;
  }
  if(c.newStreak>1)toastMsg+=' (连胜'+c.newStreak+'天)';
  if(c.broken)toastMsg+=' (连胜中断)';
  if(cost>0)toastMsg+=' (-'+fmt(cost)+' 活力)';
  toast(toastMsg);
  render();
}

function useExemption(taskId){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!t)return;
  const cfg=exemptionActivity();
  if(!cfg||!cfg.enabled){toast('断更豁免卡活动已停用','err');return;}
  if((state.cards.exemption||0)<=0){toast('没有可用豁免卡','err');return;}
  const today=new Date();today.setHours(0,0,0,0);
  const lastEff=effectiveLastTs(t);
  const prev=new Date(lastEff);prev.setHours(0,0,0,0);
  const gapDays=Math.round((today-prev)/864e5);
  // Already checked in today?
  if(t.lastCheckIn){
    const lc=new Date(t.lastCheckIn);lc.setHours(0,0,0,0);
    if(lc.getTime()>=today.getTime()){toast('今日已打卡，无需豁免','warn');return;}
  }
  // Already exempted today?
  if(t.lastExempt){
    const le=new Date(t.lastExempt);le.setHours(0,0,0,0);
    if(le.getTime()>=today.getTime()){toast('今日已豁免','warn');return;}
  }

  const prevLastExempt=t.lastExempt||null;
  const prevPendingDebt=t.pendingDebt||0;
  const prevLastDebtDate=t.lastDebtDate||null;
  const wasBroken=gapDays>=2;

  state.cards.exemption=(state.cards.exemption||0)-1;
  t.lastExempt=today.getTime()+864e5-1000; // end of today
  t.pendingDebt=0;
  delete t.lastDebtDate;

  addLog('',0,'「'+t.name+'」使用断更豁免卡'+(wasBroken?'（补救）':'（请假）'),'exempt','',{taskId:t.id,prevLastExempt:prevLastExempt,prevPendingDebt:prevPendingDebt,prevLastDebtDate:prevLastDebtDate});
  save();
  processDailyTaskDebts();
  toast('已使用断更豁免卡'+(wasBroken?'，待扣债已清零':''));
  render();
}

function checkAchievements(domId){
  state.achievements.forEach(a=>{
    if(domId&&a.domainId!==domId)return;
    const prog=domainProgress(a.domainId);
    if(!a.unlocked&&prog>=a.threshold){
      a.unlocked=true;
      a.unlockedAt=now();
      state.scores.achievement+=a.points;
      addLog('achievement',a.points,'里程碑「'+a.name+'」解锁','achievement',a.domainId,{achId:a.id});
      toast('成就解锁：'+a.name+' (+'+a.points+' 成果点)','warn');
    }
  });
}

// ===== Collections =====
function addCollection(){
  const inp=document.getElementById('collAddName');
  const name=inp.value.trim();
  if(!name){toast('请输入集合名称','err');return}
  state.collections.push({id:uid(),name:name});
  addLog('',0,'创建集合「'+name+'」','create');
  save();
  inp.value='';
  document.getElementById('collAdd').style.display='none';
  toast('集合「'+name+'」已创建');
  render();
}
function delCollection(id){
  const c=state.collections.find(x=>x.id===id);
  if(!c)return;
  if(id==='c_default'){toast('默认集合不可删除','err');return}
  // Save affected tasks for undo
  const affectedTasks=state.tasks.filter(t=>t.collectionId===id).map(t=>({id:t.id,prevCollectionId:id}));
  // reassign tasks to default
  state.tasks.forEach(t=>{if(t.collectionId===id)t.collectionId='c_default'});
  // Save collection position for undo
  const collIndex=state.collections.indexOf(c);
  const collCopy=JSON.parse(JSON.stringify(c));
  state.collections=state.collections.filter(x=>x.id!==id);
  addLog('',0,'删除集合「'+c.name+'」','delete-coll','',{collCopy:collCopy,collIndex:collIndex,affectedTasks:affectedTasks});
  save();
  toast('集合已删除，任务已移至默认');
  render();
}
function renameCollection(id){
  const c=state.collections.find(x=>x.id===id);
  if(!c)return;
  const name=prompt('重命名集合：',c.name);
  if(name&&name.trim()){c.name=name.trim();save();render()}
}

// ===== Domains =====
function addDomain(){
  const inp=document.getElementById('domAddName');
  const name=inp.value.trim();
  if(!name){toast('请输入领域名称','err');return}
  const id=uid();
  state.domains.push({id:id,name:name,createdAt:now()});
  state.scores.progress[id]=0;
  addLog('',0,'创建领域「'+name+'」','create');
  save();
  inp.value='';
  document.getElementById('domAddInline').style.display='none';
  toast('领域「'+name+'」已创建');
  render();
}
function delDomain(id){
  const d=state.domains.find(x=>x.id===id);
  if(!d)return;
  if(id==='d_default'){toast('默认领域不可删除','err');return}
  if(!confirm('删除领域「'+d.name+'」？\n（进度值将合并至默认领域，可在银行流水撤销此操作）'))return;
  const domIndex=state.domains.indexOf(d);
  const domCopy=JSON.parse(JSON.stringify(d));

  // Save affected tasks for undo
  const affectedTasks=[];
  state.tasks.forEach(t=>{
    const dids=getTaskDomainIds(t);
    if(dids.includes(id)){
      affectedTasks.push({id:t.id,prevDomainIds:JSON.parse(JSON.stringify(t.domainIds||[])),prevDomainId:t.domainId||null});
      const newDids=dids.filter(x=>x!==id);
      if(newDids.length===0)newDids.push('d_default');
      t.domainIds=newDids;
      delete t.domainId;
    }
  });

  // Save affected achievements for undo
  const affectedAchs=[];
  state.achievements.forEach(a=>{
    if(a.domainId===id){
      affectedAchs.push({id:a.id,prevDomainId:id});
      a.domainId='d_default';
    }
  });

  // merge progress into default
  const progressVal=state.scores.progress[id]||0;
  state.scores.progress['d_default']=(state.scores.progress['d_default']||0)+progressVal;
  delete state.scores.progress[id];

  state.domains=state.domains.filter(x=>x.id!==id);
  addLog('',0,'删除领域「'+d.name+'」','delete-domain','',{domCopy:domCopy,domIndex:domIndex,progressVal:progressVal,affectedTasks:affectedTasks,affectedAchs:affectedAchs});
  checkAchievements();
  save();
  toast('领域已删除，进度已合并至默认');
  render();
}
function renameDomain(id){
  const d=state.domains.find(x=>x.id===id);
  if(!d)return;
  const name=prompt('重命名领域：',d.name);
  if(name&&name.trim()){d.name=name.trim();save();render()}
}

// ===== Task CRUD =====
function saveTaskData(data){
  const recalc=data.recalc;
  delete data.recalc; // don't store on task object
  
  if(data.id){
    const t=state.tasks.find(x=>x.id===data.id);
    if(!t)return;
    
    // If recalc requested, undo old scores before applying new params
    if(recalc){
      recalcTaskHistory(t, data);
    }else{
      // Migrate accumulated progress when a progress-type task changes domains
      if(taskHasType(t,'progress')&&(data.scoreTypes||[]).indexOf('progress')>=0){
        const oldDids=getTaskDomainIds(t);
        const newDids=data.domainIds||['d_default'];
        const oldSet=new Set(oldDids);
        const newSet=new Set(newDids);
        // Only migrate if domain set actually changed
        const changed=oldDids.length!==newDids.length||oldDids.some(d=>!newSet.has(d));
        if(changed){
          const earned=t.totalEarned||0;
          if(earned!==0){
            // Undo from old domains (split equally as it was applied)
            const oldShare=earned/oldDids.length;
            oldDids.forEach(did=>{
              state.scores.progress[did]=(state.scores.progress[did]||0)-oldShare;
            });
            // Add to new domains (split equally)
            const newShare=earned/newDids.length;
            newDids.forEach(did=>{
              state.scores.progress[did]=(state.scores.progress[did]||0)+newShare;
            });
          }
        }
      }
    }
    
    Object.assign(t,data);
    if(!data.stageRewards)delete t.stageRewards;
    addLog('',0,'修改任务「'+data.name+'」','edit');
  }else{
    const nt={
      id:uid(),name:data.name,description:data.description||'',scoreTypes:data.scoreTypes||['vitality'],
      domainIds:data.domainIds||['d_default'],collectionId:data.collectionId||'c_default',
      initialValue:data.initialValue,interestRate:data.interestRate,debtRate:data.debtRate,
      vitalityCost:data.vitalityCost||0,
      lastCheckIn:null,checkInCount:0,totalEarned:0,streak:0,createdAt:now(),archived:false
    };
    if(data.stageRewards)nt.stageRewards=data.stageRewards;
    state.tasks.push(nt);
    addLog('',0,'创建任务「'+data.name+'」','create');
  }
  save();
}

// Replay all check-in logs for a task using new parameters
function recalcTaskHistory(t, newData){
  // Collect all check-in logs for this task, sorted ascending by time
  const checkinLogs=state.logs.filter(l=>l.src==='checkin'&&l.taskId===t.id)
    .sort((a,b)=>a.time-b.time);
  
  if(checkinLogs.length===0)return;
  
  // Step 1: Undo all old amounts from scores
  const oldCost=t.vitalityCost||0;
  checkinLogs.forEach(log=>{
    // Undo old net amount (including 'both' check-ins)
    applyCheckinGain(log,-1);
    // Undo old vitality cost
    if(oldCost>0){
      state.scores.vitality+=oldCost;
    }
  });
  
  // Step 2: New parameters
  const newInitial=newData.initialValue;
  const newInterest=newData.interestRate;
  const newDebt=newData.debtRate;
  const newCost=newData.vitalityCost||0;
  const newDids=newData.domainIds||['d_default'];
  const newScoreTypes=taskScoreTypes(newData);
  
  // Step 3: Replay each check-in
  let runningStreak=0;
  let runningLastCheckIn=null;
  let totalEarned=0;
  
  checkinLogs.forEach((log,idx)=>{
    const logTime=log.time;
    let gapDays=0;
    if(runningLastCheckIn){
      const prev=new Date(runningLastCheckIn);prev.setHours(0,0,0,0);
      const curr=new Date(logTime);curr.setHours(0,0,0,0);
      gapDays=Math.round((curr-prev)/864e5);
    }
    
    const isFirst=(idx===0&&!runningLastCheckIn);
    let newStreak, broken=false;
    if(isFirst){
      newStreak=1;
    }else if(gapDays<=0){
      newStreak=runningStreak||1;
    }else if(gapDays===1){
      newStreak=runningStreak+1;
    }else{
      newStreak=1; broken=true;
    }
    
    const bonus=newInitial*(newInterest/100)*Math.max(0,newStreak-1);
    const gross=newInitial+bonus;
    // Debt: pendingDebt reduces earnable amount at check-in; not tracked in replay
    const debt=0;
    const net=gross-debt;
    
    // Apply new net to scores (distribute across new domains)
    if(newScoreTypes.indexOf('vitality')>=0)state.scores.vitality+=net;
    if(newScoreTypes.indexOf('progress')>=0){
      const share=net/newDids.length;
      newDids.forEach(did=>{
        state.scores.progress[did]=(state.scores.progress[did]||0)+share;
      });
    }
    
    if(newCost>0){
      state.scores.vitality-=newCost;
    }
    
    // Update log entry
    log.amt=net;
    log.st=(newScoreTypes.indexOf('vitality')>=0&&newScoreTypes.indexOf('progress')>=0)?'both':(newScoreTypes.indexOf('progress')>=0?'progress':'vitality');
    log.dom=newScoreTypes.indexOf('progress')>=0?newDids.join(','):'';
    let desc='「'+newData.name+'」打卡';
    if(bonus>0)desc+=' (连胜'+newStreak+'天 +'+fmt(bonus)+')';
    if(newCost>0)desc+=' (消耗活力-'+fmt(newCost)+')';
    log.desc=desc;
    log.prevStreak=runningStreak;
    log.prevLastCheckIn=runningLastCheckIn;
    
    // Update linked cost log if exists
    if(oldCost>0||newCost>0){
      const costLog=state.logs.find(l=>(l.link||'')===log.id);
      if(costLog){
        if(newCost>0){
          costLog.amt=-newCost;
          costLog.desc='「'+newData.name+'」消耗活力点';
        }else{
          state.logs=state.logs.filter(l=>l.id!==costLog.id);
        }
      }else if(newCost>0&&oldCost===0){
        state.logs.push({id:uid(),time:logTime,st:'vitality',amt:-newCost,desc:'「'+newData.name+'」消耗活力点',src:'cost',dom:'',taskId:t.id,link:log.id});
      }
    }
    
    totalEarned+=net;
    runningStreak=newStreak;
    runningLastCheckIn=logTime;
  });
  
  // Step 4: Update task state
  t.streak=runningStreak;
  t.lastCheckIn=runningLastCheckIn;
  t.totalEarned=totalEarned;
  t.checkInCount=checkinLogs.length;
  
  // Re-check achievements for affected domain(s)
  if(newScoreTypes.indexOf('progress')>=0){
    newDids.forEach(did=>checkAchievements(did));
  }
  processDailyTaskDebts();
  processLoans();
}
function delTask(id){
  const t=state.tasks.find(x=>x.id===id);
  if(!t)return;
  const taskIndex=state.tasks.indexOf(t);
  const taskCopy=JSON.parse(JSON.stringify(t));

  // Move earned progress to default domain so it isn't orphaned
  let progressMoved=null;
  if(taskHasType(t,'progress')&&(t.totalEarned||0)!==0){
    const dids=getTaskDomainIds(t);
    const share=t.totalEarned/dids.length;
    const fromDomains=dids.map(did=>({did:did,amount:share}));
    dids.forEach(did=>{
      state.scores.progress[did]=(state.scores.progress[did]||0)-share;
    });
    state.scores.progress['d_default']=(state.scores.progress['d_default']||0)+t.totalEarned;
    progressMoved={fromDomains:fromDomains,totalMoved:t.totalEarned};
  }

  state.tasks=state.tasks.filter(x=>x.id!==id);
  addLog('',0,'删除任务「'+t.name+'」','delete-task','',{taskCopy:taskCopy,taskIndex:taskIndex,progressMoved:progressMoved});
  checkAchievements();
  processDailyTaskDebts();
  processLoans();
  save();
}

// ===== Achievement CRUD =====
function saveAchData(data){
  if(data.id){
    const a=state.achievements.find(x=>x.id===data.id);
    if(!a)return;
    Object.assign(a,data);
  }else{
    state.achievements.push({
      id:uid(),name:data.name,domainId:data.domainId,threshold:data.threshold,
      points:data.points,unlocked:false,unlockedAt:null
    });
    addLog('',0,'设定里程碑「'+data.name+'」','create');
  }
  save();
  checkAchievements(data.domainId);
}
function delAch(id){
  const a=state.achievements.find(x=>x.id===id);
  if(!a)return;
  const achIndex=state.achievements.indexOf(a);
  const achCopy=JSON.parse(JSON.stringify(a));
  // Don't subtract achievement points — they were earned and should be kept
  state.achievements=state.achievements.filter(x=>x.id!==id);
  addLog('',0,'删除里程碑「'+a.name+'」','delete-ach','',{achCopy:achCopy,achIndex:achIndex});
  save();
}

// ===== Metric (Radar) CRUD =====
function openMetricModal(id){
  const m=id?state.metrics.find(x=>x.id===id):null;
  document.getElementById('metricId').value=id||'';
  document.getElementById('metricModalTitle').textContent=id?'编辑指标':'自定义指标';
  document.getElementById('metricName').value=m?m.name:'';
  fillDomainChecklist(document.getElementById('metricDomainList'),m?(m.domainIds||[]):['d_default']);
  openModal('metricModal');
  setTimeout(()=>document.getElementById('metricName').focus(),50);
}
function getCheckedMetricDomains(){
  const ids=[];
  document.querySelectorAll('#metricDomainList .dom-check input:checked').forEach(cb=>ids.push(cb.value));
  return ids;
}
function handleMetricSave(){
  const id=document.getElementById('metricId').value;
  const name=document.getElementById('metricName').value.trim();
  const domainIds=getCheckedMetricDomains();
  if(!name){toast('请输入指标名称','err');return}
  if(!domainIds.length){toast('请至少选择一个领域','err');return}
  if(id){
    const m=state.metrics.find(x=>x.id===id);
    if(!m)return;
    m.name=name;m.domainIds=domainIds;
  }else{
    state.metrics.push({id:uid(),name:name,domainIds:domainIds});
  }
  save();
  closeModal('metricModal');
  toast(id?'指标已更新':'指标已添加');
  render();
}
function delMetric(id){
  const m=state.metrics.find(x=>x.id===id);
  if(!m)return;
  if(!confirm('删除指标「'+m.name+'」？'))return;
  state.metrics=state.metrics.filter(x=>x.id!==id);
  save();
  render();
}

// ===== Shop Categories =====
function addShopCategory(){
  const inp=document.getElementById('shopCatAddName');
  const name=inp.value.trim();
  if(!name){toast('请输入分类名称','err');return}
  state.shopCategories.push({id:uid(),name:name});
  addLog('',0,'创建商品分类「'+name+'」','create');
  save();
  inp.value='';
  document.getElementById('shopCatAdd').style.display='none';
  toast('分类「'+name+'」已创建');
  render();
}
function delShopCategory(id){
  const c=state.shopCategories.find(x=>x.id===id);
  if(!c)return;
  if(id==='sc_default'){toast('默认分类不可删除','err');return}
  if(!confirm('删除商品分类「'+c.name+'」？\n（商品将移至默认分类，可在银行流水撤销此操作）'))return;
  const catIndex=state.shopCategories.indexOf(c);
  const catCopy=JSON.parse(JSON.stringify(c));
  const affectedProducts=[];
  state.products.forEach(p=>{
    if(p.categoryId===id){
      affectedProducts.push({id:p.id,prevCategoryId:id});
      p.categoryId='sc_default';
    }
  });
  state.shopCategories=state.shopCategories.filter(x=>x.id!==id);
  addLog('',0,'删除商品分类「'+c.name+'」','delete-shopcat','',{catCopy:catCopy,catIndex:catIndex,affectedProducts:affectedProducts});
  save();
  toast('分类已删除，商品已移至默认');
  render();
}
function renameShopCategory(id){
  const c=state.shopCategories.find(x=>x.id===id);
  if(!c)return;
  const name=prompt('重命名分类：',c.name);
  if(name&&name.trim()){c.name=name.trim();save();render()}
}
function fillShopCatSelect(sel,selected){
  sel.innerHTML=state.shopCategories.map(c=>
    '<option value="'+c.id+'"'+(c.id===selected?' selected':'')+'>'+esc(c.name)+'</option>'
  ).join('');
}

// ===== Product CRUD =====
function saveProdData(data){
  if(data.id){
    const p=state.products.find(x=>x.id===data.id);
    if(!p)return;
    Object.assign(p,data);
  }else{
    state.products.push({
      id:uid(),name:data.name,desc:data.desc,currency:data.currency,
      price:data.price,stock:data.stock,categoryId:data.categoryId||'sc_default',
      debtRate:data.debtRate||0,
      sold:0,createdAt:now()
    });
    addLog('',0,'上架商品「'+data.name+'」','create');
  }
  save();
}
function delProd(id){
  const p=state.products.find(x=>x.id===id);
  if(!p)return;
  const prodIndex=state.products.indexOf(p);
  const prodCopy=JSON.parse(JSON.stringify(p));
  state.products=state.products.filter(x=>x.id!==id);
  addLog('',0,'删除商品「'+p.name+'」','delete-prod','',{prodCopy:prodCopy,prodIndex:prodIndex});
  save();
}
function buyProduct(id){
  const p=state.products.find(x=>x.id===id);
  if(!p)return;
  if(p.stock===0){toast('已售罄','err');return}
  const cn=p.currency==='vitality'?'活力点':'成果点';
  const balance=state.scores[p.currency];
  const willLoan=balance<p.price;
  const loanAmt=willLoan?(p.price-balance):0;
  const loanId=uid();

  state.scores[p.currency]-=p.price;
  if(p.stock>0)p.stock--;
  p.sold=(p.sold||0)+1;

  let desc='购买「'+p.name+'」';
  if(willLoan){
    desc+=' (贷款'+fmt(loanAmt)+' '+cn+')';
    state.loans.push({
      id:loanId,
      amount:loanAmt,
      debtRate:p.debtRate||0,
      currency:p.currency,
      productId:p.id,
      productName:p.name,
      date:now()
    });
  }
  addLog(p.currency,-p.price,desc,'purchase','',{prodId:p.id,loanId:willLoan?loanId:''});
  save();
  processDailyTaskDebts();
  processLoans();
  toast('已购买：'+p.name+' (-'+fmt(p.price)+' '+cn+')'+(willLoan?' · 贷款'+fmt(loanAmt):''));
  render();
}

// ===== Daily task debt processing =====
// Accumulates pending debt on each task (does NOT deduct from total scores).
// Debt is only applied at check-in time, reducing the earnable amount.
// If net (gross - pendingDebt) goes negative, the excess is deducted from total scores.
function processDailyTaskDebts(){
  const today=new Date();today.setHours(0,0,0,0);

  state.tasks.forEach(task=>{
    if(task.debtRate<=0)return;
    if(!task.lastCheckIn)return;

    const prev=new Date(effectiveLastTs(task));prev.setHours(0,0,0,0);
    const gapDays=Math.round((today-prev)/864e5);

    // Only accumulate debt if streak is broken (gap >= 2 days)
    if(gapDays<2)return;

    // Calculate how many debt days have already been accumulated
    let lastDebtDay;
    if(task.lastDebtDate){
      lastDebtDay=new Date(task.lastDebtDate);lastDebtDay.setHours(0,0,0,0);
    }else{
      // First time: debt starts from the day after lastCheckIn
      lastDebtDay=new Date(prev.getTime()+864e5);
    }

    const daysSince=Math.round((today-lastDebtDay)/864e5);
    if(daysSince<=0)return;

    // Accumulate to pendingDebt (don't touch total scores)
    const dailyDebt=task.initialValue*(task.debtRate/100);
    task.pendingDebt=(task.pendingDebt||0)+dailyDebt*daysSince;
    task.lastDebtDate=today.getTime();
  });

  save();
}

// ===== Metabolism (auto-archive / auto-delete) =====
// Tasks not checked in for 2+ weeks get archived; never-checked tasks get deleted after 2 weeks.
function processMetabolism(){
  const today=new Date();today.setHours(0,0,0,0);
  const twoWeeks=14*864e5;
  let changed=false;
  const toDelete=[];
  state.tasks.forEach(task=>{
    if(task.archived)return; // already archived
    const lastTs=effectiveLastTs(task);
    if(!lastTs){
      // Never checked in and never exempted: check createdAt
      const created=task.createdAt||now();
      if(today.getTime()-created>=twoWeeks){
        toDelete.push(task);
      }
      return;
    }
    const last=new Date(lastTs);last.setHours(0,0,0,0);
    if(today.getTime()-last.getTime()>=twoWeeks){
      // Has been checked in before, now inactive 2+ weeks → archive
      task.archived=true;
      task.archivedAt=now();
      changed=true;
      addLog('',0,'任务「'+task.name+'」连续两周未打卡，已归档','archive','',{taskId:task.id});
    }
  });
  if(toDelete.length){
    toDelete.forEach(t=>{
      addLog('',0,'任务「'+t.name+'」从未打卡且超两周，已自动删除','auto-delete','',{taskName:t.name});
    });
    const ids=new Set(toDelete.map(t=>t.id));
    state.tasks=state.tasks.filter(t=>!ids.has(t.id));
    changed=true;
  }
  if(changed)save();
}
function unlockTask(taskId){
  const t=state.tasks.find(x=>x.id===taskId);
  if(!t||!t.archived)return;
  const cost=3;
  if((state.scores.vitality||0)<cost){toast('活力点不足（需要'+cost+'点）','err');return}
  state.scores.vitality-=cost;
  t.archived=false;
  delete t.archivedAt;
  // Reset streak/debt so it's a fresh start
  t.pendingDebt=0;
  delete t.lastDebtDate;
  addLog('vitality',-cost,'解锁归档任务「'+t.name+'」 (-'+cost+'活力)','unlock','',{taskId:t.id});
  save();
  toast('已解锁「'+t.name+'」，可重新打卡');
  render();
}

// ===== Loan processing (daily interest) =====
function processLoans(){
  if(!state.loans)state.loans=[];
  
  // Process daily interest if days have passed
  if(state.loans.length>0){
    const today=new Date();today.setHours(0,0,0,0);
    let lastDate;
    if(state.lastDebtDate){
      lastDate=new Date(state.lastDebtDate);lastDate.setHours(0,0,0,0);
    }else{
      lastDate=today;
    }
    const days=Math.round((today-lastDate)/864e5);
    if(days>0){
      state.loans.forEach(loan=>{
        if(loan.debtRate<=0)return;
        var totalInterest=0;
        for(let i=0;i<days;i++){
          var interest=loan.amount*(loan.debtRate/100);
          loan.amount+=interest;
          totalInterest+=interest;
        }
        if(totalInterest>0){
          state.scores[loan.currency]-=totalInterest;
          addLog(loan.currency,-totalInterest,
            '贷款「'+loan.productName+'」'+days+'天利息 ('+fmt(loan.debtRate)+'%/天)',
            'loan-interest','',{loanId:loan.id});
        }
      });
      state.lastDebtDate=today.getTime();
    }
  }else{
    state.lastDebtDate=now();
  }

  // Auto-pay loans when balance is sufficient (always check)
  if(state.loans.length>0){
    const remaining=[];
    state.loans.forEach(loan=>{
      if(state.scores[loan.currency]>=loan.amount){
        state.scores[loan.currency]-=loan.amount;
        addLog(loan.currency,-loan.amount,'偿还贷款「'+loan.productName+'」','loan-repay','',{loanId:loan.id,loanCopy:JSON.parse(JSON.stringify(loan))});
      }else{
        remaining.push(loan);
      }
    });
    state.loans=remaining;
  }
  save();
}

// ===== Tab =====
function goTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));
}

// ===== Helpers for selects =====
function fillCollectionSelect(sel,selected){
  sel.innerHTML=state.collections.map(c=>
    '<option value="'+c.id+'"'+(c.id===selected?' selected':'')+'>'+esc(c.name)+'</option>'
  ).join('');
}
function fillDomainSelect(sel,selected){
  sel.innerHTML=state.domains.map(d=>
    '<option value="'+d.id+'"'+(d.id===selected?' selected':'')+'>'+esc(d.name)+'</option>'
  ).join('');
}
// Multi-select domain checklist for task modal
function fillDomainChecklist(container, selectedIds){
  const selSet=new Set(selectedIds);
  container.innerHTML=state.domains.map(d=>{
    const isSel=selSet.has(d.id);
    return '<label class="dom-check'+(isSel?' sel':'')+'" data-dom-id="'+d.id+'">'
      +'<input type="checkbox" value="'+d.id+'" '+(isSel?'checked':'')+'>'
      +'<span>'+esc(d.name)+'</span></label>';
  }).join('');
  // Toggle visual state on click
  container.querySelectorAll('.dom-check').forEach(lbl=>{
    lbl.addEventListener('click',function(e){
      if(e.target.tagName==='INPUT')return; // let checkbox handle itself
      const cb=this.querySelector('input');
      cb.checked=!cb.checked;
      this.classList.toggle('sel',cb.checked);
    });
    lbl.querySelector('input').addEventListener('change',function(){
      lbl.classList.toggle('sel',this.checked);
    });
  });
}
function getCheckedDomainIds(){
  const ids=[];
  document.querySelectorAll('#taskDomainList .dom-check input:checked').forEach(cb=>ids.push(cb.value));
  return ids.length>0?ids:['d_default'];
}

// ===== Render: Work =====
function renderWork(){
  const wV=document.getElementById('wVitality');
  wV.textContent=fmt(state.scores.vitality);
  wV.classList.toggle('neg',state.scores.vitality<0);
  const wP=document.getElementById('wProgress');
  wP.textContent=fmt(totalProgress());
  wP.classList.toggle('neg',totalProgress()<0);
  const wA=document.getElementById('wAchievement');
  wA.textContent=fmt(state.scores.achievement);
  wA.classList.toggle('neg',state.scores.achievement<0);

  const domCount=state.domains.length;
  document.getElementById('wProgressSub').textContent=domCount>1?domCount+'个领域':'';

  // Domain pills (clickable to filter tasks)
  const dp=document.getElementById('domainPills');
  let dpHtml=state.domains.map(d=>{
    const val=domainProgress(d.id);
    const isActive=state.filterDomain===d.id;
    let pill='<div class="domain-pill'+(isActive?' active':'')+'" onclick="filterByDomain(\''+d.id+'\')" style="cursor:pointer"><span class="dp-dot"></span>'+esc(d.name)+' <span class="dp-val">'+fmt(val)+'</span>';
    if(d.id!=='d_default'){
      pill+='<span class="dp-mgmt" onclick="event.stopPropagation()"><button onclick="renameDomain(\''+d.id+'\')" title="重命名">✎</button><button class="dp-del" onclick="delDomain(\''+d.id+'\')" title="删除">×</button></span>';
    }
    pill+='</div>';
    return pill;
  }).join('');
  dpHtml+='<div class="domain-pill add" onclick="toggleInline(\'domAddInline\')">+ 领域</div>';
  // inline add for domain
  dpHtml+='<div class="inline-add" id="domAddInline" style="display:none;margin-top:6px;width:100%">'
    +'<input type="text" id="domAddName" placeholder="输入领域名称" maxlength="20" autocomplete="off">'
    +'<button class="btn btn-sm" onclick="addDomain()">添加</button></div>';
  dp.innerHTML=dpHtml;

  // Task groups by collection
  const tg=document.getElementById('taskGroups');
  if(!state.tasks.length){
    tg.innerHTML='<div class="empty"><p>还没有任务，创建一个开始积累分数</p><button class="btn btn-sm" onclick="openTaskModal()">新建任务</button></div>';
  }else{
    let html='';
    state.collections.forEach(c=>{
      const tasks=state.tasks.filter(t=>!t.archived&&t.collectionId===c.id&&(!state.filterDomain||!taskHasType(t,'progress')||getTaskDomainIds(t).includes(state.filterDomain)));
      const isCollapsed=(state.collapsedColls||[]).includes(c.id);
      html+='<div class="coll-group'+(isCollapsed?' collapsed':'')+'" data-coll-id="'+c.id+'">';
      // Header (clickable to toggle collapse)
      html+='<div class="coll-header" onclick="toggleCollapse(\'collection\',\''+c.id+'\')">';
      html+='<div class="coll-name"><span class="coll-toggle">▼</span>'+esc(c.name)+' <span class="coll-count">'+tasks.length+'个任务</span></div>';
      html+='<div class="coll-actions" onclick="event.stopPropagation()">';
      html+='<span class="drag-handle" title="拖拽集合">⋮⋮</span>';
      html+='<button onclick="openTaskModal(null,\''+c.id+'\')">+ 任务</button>';
      if(c.id!=='c_default'){
        html+='<button onclick="renameCollection(\''+c.id+'\')">重命名</button><button onclick="delCollection(\''+c.id+'\')">删除</button>';
      }
      html+='</div>';
      html+='</div>';
      // Body (collapsible)
      html+='<div class="coll-body">';
      if(tasks.length===0){
        html+='<div class="empty" style="padding:16px"><p style="margin:0;color:var(--text-3)">暂无任务 · 拖拽 ⋮⋮ 按钮可排序</p></div>';
      }else{
        html+=tasks.map(t=>taskCardHTML(t,c.id)).join('');
      }
      html+='</div>';
      html+='</div>';
    });
    // Tasks without valid collection
    const noColl=state.tasks.filter(t=>!t.archived&&!state.collections.find(c=>c.id===t.collectionId)&&(!state.filterDomain||!taskHasType(t,'progress')||getTaskDomainIds(t).includes(state.filterDomain)));
    if(noColl.length){
      html+='<div class="coll-group" data-coll-id="_none"><div class="coll-header" onclick="toggleCollapse(\'collection\',\'_none\')"><div class="coll-name"><span class="coll-toggle">▼</span>未分类 <span class="coll-count">'+noColl.length+'个任务</span></div><div class="coll-actions" onclick="event.stopPropagation()"><span class="drag-handle" title="拖拽集合">⋮⋮</span></div></div>';
      html+='<div class="coll-body">'+noColl.map(t=>taskCardHTML(t,'_none')).join('')+'</div>';
      html+='</div>';
    }
    tg.innerHTML=html;
  }

  // Archive section
  const archived=state.tasks.filter(t=>t.archived);
  const am=document.getElementById('archiveMeta');
  if(am)am.textContent=archived.length?'（'+archived.length+'个任务）':'';
  const ab=document.getElementById('archiveGroups');
  if(ab){
    if(archived.length===0){
      ab.innerHTML='<div class="empty" style="padding:12px"><p style="margin:0;color:var(--text-3)">连续两周未打卡的任务将自动归档至此</p></div>';
    }else{
      const isCollapsed=(state.collapsedColls||[]).includes('_archive');
      ab.innerHTML='<div class="coll-group'+(isCollapsed?' collapsed':'')+'" data-coll-id="_archive">'
        +'<div class="coll-header" onclick="toggleCollapse(\'collection\',\'_archive\')">'
        +'<div class="coll-name"><span class="coll-toggle">▼</span>已归档 <span class="coll-count">'+archived.length+'个任务</span></div>'
        +'</div>'
        +'<div class="coll-body">'+archived.map(t=>{
          const cost=3;
          const canUnlock=(state.scores.vitality||0)>=cost;
          return '<div class="card" style="opacity:.7">'
            +'<div class="card-top"><div>'+(taskHasType(t,'progress')?'<span class="tag p">进度值</span>':'')+(taskHasType(t,'vitality')?'<span class="tag v">活力点</span>':'')+'<span class="card-title">'+esc(t.name)+'</span></div>'
            +'<div class="card-actions"><button onclick="openTaskModal(\''+t.id+'\')">编辑</button><button class="del" onclick="confirmDelTask(\''+t.id+'\')">删除</button></div></div>'
            +'<div class="card-meta"><span>打卡 '+(t.checkInCount||0)+' 次</span><span>归档于 '+(t.archivedAt?fmtTime(t.archivedAt):'—')+'</span></div>'
            +'<div class="card-bottom"><div class="preview"><span style="color:var(--text-3)">需 '+cost+' 活力点解锁</span></div><button class="btn btn-sm btn-exempt" onclick="unlockTask(\''+t.id+'\')" '+(canUnlock?'':'disabled')+'>解锁</button></div>'
            +'</div>';
        }).join('')+'</div></div>';
    }
  }
}

function stageBarHTML(t){
  const cell=stageSel(t);
  const hasV=taskHasType(t,'vitality');
  const hasP=taskHasType(t,'progress');
  let reward='+'+fmt(hasV?stageValueAt(t,'vitality',cell):stageValueAt(t,'progress',cell));
  reward+=hasV&&hasP?(' 活力 / +'+fmt(stageValueAt(t,'progress',cell))+' 进度'):(hasV?' 活力':' 进度');
  const label=stageCellLabel(cell);
  let ticks='';
  for(let i=0;i<10;i++){ticks+='<i class="stage-tick'+(i%2===0?' major':'')+'" style="left:'+(i*10)+'%"></i>';}
  const anchorLabels=STAGE_NAMES.map((n,k)=>'<span'+(k===(cell>>1)?' class="on"':'')+' style="left:'+(k*20)+'%">'+n+'</span>').join('');
  let curStreak=t.streak||0;if(curStreak===0&&t.lastCheckIn)curStreak=1;
  let meta='';if(curStreak>0)meta+='连胜'+curStreak+'天';
  const pend=t.pendingDebt||0;if(pend>0)meta+=(meta?' · ':'')+'待扣债'+fmt(pend);
  return '<div class="stage-bar" data-tid="'+t.id+'">'
    +'<div class="stage-track">'+ticks+'<div class="stage-thumb" style="left:'+(cell*10+5)+'%"></div></div>'
    +'<div class="stage-labels">'+anchorLabels+'</div>'
    +'<div class="stage-preview">'+label+' · '+reward+(meta?' · '+meta:'')+'</div>'
    +'</div>';
}

function taskCardHTML(t,collId){
  const c=calcCheckIn(t);
  const s=calcSkip(t);
  const staged=taskIsStaged(t);
  const types=taskScoreTypes(t);
  const hasV=types.indexOf('vitality')>=0;
  const hasP=types.indexOf('progress')>=0;
  const isV=!hasP;
  const name=hasV&&hasP?'活力+进度':(hasP?'进度值':'活力点');
  const posClass=hasP?'pos p':'pos';
  const typeTag=hasV&&hasP
    ?'<span class="tag v">活力点</span><span class="tag p">进度值</span>'
    :(hasP?'<span class="tag p">进度值</span>':'<span class="tag v">活力点</span>');
  const sign=c.net>=0?'+':'';
  const cost=t.vitalityCost||0;
  // Use effective streak for display consistency with calcCheckIn
  let curStreak=t.streak||0;
  if(curStreak===0&&t.lastCheckIn)curStreak=1;

  // Preview: show check-in result and skip penalty
  let prev='';
  prev+='<span style="color:var(--text-2)">打卡</span> <span class="'+posClass+'">'+sign+fmt(c.net)+'</span>';
  if(c.bonus>0)prev+=' <span class="'+posClass+'">(连胜'+c.newStreak+'天 +'+fmt(c.bonus)+')</span>';
  if(c.debt>0)prev+=' <span class="neg">(抵扣待扣债-'+fmt(c.debt)+')</span>';
  if(cost>0)prev+=' <span class="neg">(活力-'+fmt(cost)+')</span>';

  if(s.debt>0){
    prev+='　<span style="color:var(--text-2)">不打卡</span> <span class="neg">待扣债+'+fmt(s.debt)+'</span>';
  }else if(c.isFirst){
    prev+='　<span style="color:var(--text-3)">不打卡：无惩罚</span>';
  }else if(c.gapDays<=0){
    prev+='　<span style="color:var(--text-3)">已打卡</span>';
  }else if(c.gapDays===1){
    prev+='　<span style="color:var(--text-3)">今日未打卡，明日累积待扣债</span>';
  }else{
    prev+='　<span style="color:var(--text-3)">已断更'+(c.gapDays-1)+'天</span>';
  }

  const domTags=!isV?getTaskDomainIds(t).map(did=>'<span class="tag d">'+esc(domainName(did))+'</span>').join(''):'';
  const streakTag=curStreak>0?'<span class="tag d">连胜'+curStreak+'天</span>':'';

  // Exemption card eligibility
  const todayStart=new Date();todayStart.setHours(0,0,0,0);
  const checkedToday=!!(t.lastCheckIn&&new Date(t.lastCheckIn)>=todayStart);
  const exemptToday=!!(t.lastExempt&&new Date(t.lastExempt)>=todayStart);
  const cards=(state.cards&&state.cards.exemption)||0;
  const exAct=exemptionActivity();
  const ruleEnabled=!!(exAct&&exAct.enabled);
  const canExempt=ruleEnabled&&cards>0&&!checkedToday&&!exemptToday;
  const exemptLabel=c.gapDays>=2?'补救':'请假';
  const exemptBtn=canExempt
    ?'<button class="btn btn-sm btn-exempt" title="剩余豁免卡 '+cards+' 张" onclick="useExemption(\''+t.id+'\')">豁免·'+exemptLabel+'</button>'
    :'';

  const checkinBtn='<button class="btn btn-sm btn-checkin" onclick="checkIn(\''+t.id+'\')" '+(cost>0&&state.scores.vitality<cost?'title="活力点不足，将进入负值（贷款）"':'')+'>打卡</button>';
  return '<div class="card task-card" data-task-id="'+t.id+'" data-coll-id="'+(collId||'')+'">'
    +'<div class="task-row">'
    +'<div class="task-title-wrap">'
    +(hasV?'<span class="tdot v" title="活力点"></span>':'')+(hasP?'<span class="tdot p" title="进度值"></span>':'')
    +'<span class="card-title">'+esc(t.name)+'</span>'
    +'</div>'
    +'<div class="task-row-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span>'+checkinBtn+'</div>'
    +'</div>'
    +(staged?'<div class="task-stage-row">'+stageBarHTML(t)+'</div>':'')
    +'<div class="task-extra">'
    +'<div class="card-top">'
    +'<div>'+typeTag+domTags+streakTag+'</div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span><button onclick="openTaskModal(\''+t.id+'\')">编辑</button><button class="del" onclick="confirmDelTask(\''+t.id+'\')">删除</button></div>'
    +'</div>'
    +'<div class="card-meta">'
    +'<span>初始 <b>'+fmt(t.initialValue)+'</b></span>'
    +'<span>利率 <b>'+fmt(t.interestRate)+'%</b>/连胜天</span>'
    +'<span>债率 <b>'+fmt(t.debtRate)+'%</b>/断更天</span>'
    +(cost>0?'<span style="color:var(--vitality)">活力消耗 <b>'+fmt(cost)+'</b></span>':'')
    +'<span>打卡 <b>'+(t.checkInCount||0)+'</b>次</span>'
    +'<span>上次 <b>'+fmtTime(t.lastCheckIn)+'</b></span>'
    +'</div>'
    +'<div class="card-bottom">'
    +(staged?stageBarHTML(t):'<div class="preview">'+prev+'</div>')
    +checkinBtn
    +'</div>'
    +'</div>'
    +'</div>';
}

// ===== 阶段奖励：卡片进度条拖拽 =====
function updateStageBar(track,tid,cell){
  const t=state.tasks.find(x=>x.id===tid);if(!t)return;
  const thumb=track.querySelector('.stage-thumb');if(thumb)thumb.style.left=(cell*10+5)+'%';
  const bar=track.closest('.stage-bar');
  if(bar){
    const spans=bar.querySelectorAll('.stage-labels span');
    spans.forEach(function(n,k){n.classList.toggle('on',k===(cell>>1));});
    const preview=bar.querySelector('.stage-preview');
    if(preview){
      const hasV=taskHasType(t,'vitality'),hasP=taskHasType(t,'progress');
      let reward='+'+fmt(hasV?stageValueAt(t,'vitality',cell):stageValueAt(t,'progress',cell));
      reward+=hasV&&hasP?(' 活力 / +'+fmt(stageValueAt(t,'progress',cell))+' 进度'):(hasV?' 活力':' 进度');
      let cs=t.streak||0;if(cs===0&&t.lastCheckIn)cs=1;
      let meta='';if(cs>0)meta+='连胜'+cs+'天';
      const pend2=t.pendingDebt||0;if(pend2>0)meta+=(meta?' · ':'')+'待扣债'+fmt(pend2);
      preview.textContent=stageCellLabel(cell)+' · '+reward+(meta?' · '+meta:'');
    }
  }
}
function setStageFromX(track,tid,clientX){
  const t=state.tasks.find(x=>x.id===tid);if(!t||!taskIsStaged(t))return;
  const rect=track.getBoundingClientRect();
  let p=(clientX-rect.left)/rect.width;
  p=Math.max(0,Math.min(1,p));
  let cell=Math.floor(p*10);if(cell>9)cell=9;if(cell<0)cell=0; // 吸附到 10 个格位 0..9
  if(t.stageRewards)t.stageRewards.last=cell;
  updateStageBar(track,tid,cell);
}
function initStageBars(){
  document.querySelectorAll('.stage-bar[data-tid]').forEach(function(bar){
    const track=bar.querySelector('.stage-track');
    if(!track||track._stageBound)return;
    track._stageBound=true;
    const tid=bar.dataset.tid;
    let dragging=false;
    track.addEventListener('pointerdown',function(e){
      if(!state.tasks.find(x=>x.id===tid))return;
      if(track.setPointerCapture){try{track.setPointerCapture(e.pointerId);}catch(err){}}
      dragging=true;
      setStageFromX(track,tid,e.clientX);
      e.preventDefault();
    });
    track.addEventListener('pointermove',function(e){if(dragging)setStageFromX(track,tid,e.clientX);});
    function end(){if(dragging){dragging=false;save();}}
    track.addEventListener('pointerup',end);
    track.addEventListener('pointercancel',end);
  });
}

// ===== 任务卡片：长按 1 秒浮现详情，3 秒后自动淡出 =====
let taskReveal={card:null,timer:null,startX:0,startY:0};
function initTaskReveal(){
  document.addEventListener('pointerdown',function(e){
    const card=e.target.closest?e.target.closest('.task-card'):null;
    if(!card)return;
    // 不拦截交互控件（拖拽把手/按钮等）
    if(e.target.closest&&e.target.closest('.drag-handle,.card-actions,button,a,input,select,textarea,.task-extra,.stage-bar'))return;
    taskReveal.card=card;
    taskReveal.startX=e.clientX;taskReveal.startY=e.clientY;
    clearTimeout(taskReveal.timer);
    taskReveal.timer=setTimeout(function(){showTaskExtra(card);},1000);
  });
  document.addEventListener('pointermove',function(e){
    if(!taskReveal.card)return;
    if(Math.abs(e.clientX-taskReveal.startX)>12||Math.abs(e.clientY-taskReveal.startY)>12){
      clearTimeout(taskReveal.timer);taskReveal.timer=null;taskReveal.card=null;
    }
  });
  ['pointerup','pointercancel'].forEach(function(ev){
    document.addEventListener(ev,function(){
      if(taskReveal.card){clearTimeout(taskReveal.timer);taskReveal.timer=null;taskReveal.card=null;}
    });
  });
  // 阻止长按触发系统右键/文本选择菜单
  document.addEventListener('contextmenu',function(e){
    if(e.target.closest&&e.target.closest('.task-card'))e.preventDefault();
  });
}
function showTaskExtra(card){
  card.classList.add('revealed');
  clearTimeout(card._taskHideTimer);
  card._taskHideTimer=setTimeout(function(){card.classList.remove('revealed');},3000);
}

function achCardHTML(a,domId){
  const prog=domainProgress(a.domainId);
  const pct=Math.min(100,(prog/a.threshold)*100);
  return '<div class="card" data-ach-id="'+a.id+'" data-dom-id="'+(domId||a.domainId)+'">'
    +'<div class="card-top">'
    +'<div><span class="tag a">成果</span><span class="card-title">'+(a.unlocked?'✓ ':'')+esc(a.name)+'</span></div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序">⋮⋮</span><button onclick="openAchModal(\''+a.id+'\')">编辑</button><button class="del" onclick="confirmDelAch(\''+a.id+'\')">删除</button></div>'
    +'</div>'
    +'<div class="card-meta">'
    +'<span>领域 <b>'+esc(domainName(a.domainId))+'</b></span>'
    +'<span>门槛 <b>'+fmt(a.threshold)+'</b></span>'
    +'<span>奖励 <b>'+fmt(a.points)+'</b>成果点</span>'
    +(a.unlocked?'<span style="color:var(--achievement)">已解锁 · '+fmtTime(a.unlockedAt)+'</span>':'<span>当前 '+fmt(prog)+'/'+fmt(a.threshold)+'</span>')
    +'</div>'
    +(a.unlocked?'':'<div class="prog-bar"><div class="prog-fill" style="width:'+pct+'%"></div></div>')
    +'</div>';
}

// ===== Render: Bank =====
function renderBank(){
  const bV=document.getElementById('bVitality');
  bV.textContent=fmt(state.scores.vitality);
  bV.classList.toggle('neg',state.scores.vitality<0);
  const bP=document.getElementById('bProgress');
  bP.textContent=fmt(totalProgress());
  bP.classList.toggle('neg',totalProgress()<0);
  const bA=document.getElementById('bAchievement');
  bA.textContent=fmt(state.scores.achievement);
  bA.classList.toggle('neg',state.scores.achievement<0);

  // Radar (domain capability) + metric chips
  renderRadar();
  renderMetricChips();

  // Loan display
  const lb=document.getElementById('loanBox');
  if(state.loans&&state.loans.length>0){
    lb.style.display='block';
    let lhtml='<div class="lb-title">贷款 ('+state.loans.length+'笔)</div>';
    lhtml+=state.loans.map(l=>{
      const cn=l.currency==='vitality'?'活力点':'成果点';
      const days=l.date?Math.max(0,Math.round((now()-l.date)/864e5)):0;
      const dailyInterest=l.debtRate>0?l.amount*(l.debtRate/100):0;
      return '<div class="loan-item">'
        +'<div class="li-name">'+esc(l.productName)+' · '+cn+(l.debtRate>0?' · 债率'+fmt(l.debtRate)+'%/天':'')+'</div>'
        +'<div class="li-amt">欠 '+fmt(l.amount)+(days>0?' · 已借'+days+'天':'')+(dailyInterest>0?' · 日息-'+fmt(dailyInterest):'')+'</div>'
        +'</div>';
    }).join('');
    lb.innerHTML=lhtml;
  }else{
    lb.style.display='none';
  }

  // Stats
  const vIn=sumLog('vitality',true),vOut=sumLog('vitality',false);
  const pIn=sumLog('progress',true);
  const aIn=sumLog('achievement',true),aOut=sumLog('achievement',false);
  const totalCI=state.tasks.reduce((s,t)=>s+(t.checkInCount||0),0);
  const unlocked=state.achievements.filter(a=>a.unlocked).length;
  const purchases=state.logs.filter(l=>l.src==='purchase').length;

  var vIncomeEl=document.getElementById('vIncome');
  vIncomeEl.textContent=fmt(vIn);
  vIncomeEl.classList.toggle('neg',vIn<0);
  document.getElementById('vSpend').textContent=fmt(vOut);
  var pIncomeEl=document.getElementById('pIncome');
  pIncomeEl.textContent=fmt(pIn);
  pIncomeEl.classList.toggle('neg',pIn<0);
  document.getElementById('totalCheckins').textContent=totalCI;
  var aIncomeEl=document.getElementById('aIncome');
  aIncomeEl.textContent=fmt(aIn);
  aIncomeEl.classList.toggle('neg',aIn<0);
  document.getElementById('achUnlocked').textContent=unlocked;
  var aSpendEl=document.getElementById('aSpend');
  aSpendEl.textContent=fmt(aOut);
  aSpendEl.classList.toggle('neg',aOut<0);
  document.getElementById('totalPurchases').textContent=purchases;

  document.getElementById('bVitalitySub').textContent='收入'+fmt(vIn)+' / 消费'+fmt(vOut);
  document.getElementById('bProgressSub').textContent=state.domains.length+'个领域';
  document.getElementById('bAchSub').textContent='收入'+fmt(aIn)+' / 消费'+fmt(aOut);

  // Milestones grouped by domain
  const ag=document.getElementById('achGroups');
  if(!state.achievements.length){
    ag.innerHTML='<div class="empty"><p>设定里程碑，领域进度达标后自动解锁成果点</p><button class="btn btn-sm" onclick="openAchModal()">新建里程碑</button></div>';
  }else{
    let ahtml='';
    state.domains.forEach(d=>{
      const achs=state.achievements.filter(a=>a.domainId===d.id);
      if(achs.length===0)return;
      const isCollapsed=(state.collapsedAchDoms||[]).includes(d.id);
      const showHeader=state.domains.length>1;
      ahtml+='<div class="ach-dom-group'+(isCollapsed?' collapsed':'')+'" data-dom-id="'+d.id+'">';
      if(showHeader){
        ahtml+='<div class="coll-header" onclick="toggleCollapse(\'ach-domain\',\''+d.id+'\')">';
        ahtml+='<div class="coll-name"><span class="coll-toggle">▼</span>'+esc(d.name)+' <span class="coll-count">'+achs.length+'个里程碑</span></div>';
        ahtml+='<div class="coll-actions" onclick="event.stopPropagation()">';
        ahtml+='<span class="drag-handle" title="拖拽领域">⋮⋮</span>';
        if(d.id!=='d_default'){
          ahtml+='<button onclick="renameDomain(\''+d.id+'\')">重命名</button><button onclick="delDomain(\''+d.id+'\')">删除</button>';
        }
        ahtml+='<button onclick="openAchModal(null,\''+d.id+'\')">+ 里程碑</button>';
        ahtml+='</div>';
        ahtml+='</div>';
      }
      ahtml+='<div class="coll-body">';
      ahtml+=achs.map(a=>achCardHTML(a,d.id)).join('');
      ahtml+='</div>';
      ahtml+='</div>';
    });
    ag.innerHTML=ahtml;
  }

  drawChart();
  drawVitalityFlowChart();
  drawWeekCompareChart();

  // Logs
  document.getElementById('logMeta').textContent=state.logs.length+' 条';
  const ll=document.getElementById('logList');
  if(!state.logs.length){
    ll.innerHTML='<div class="empty" style="padding:24px"><p style="margin:0">暂无记录</p></div>';
  }else{
    const undoableSrc=['checkin','cost','purchase','achievement','loan-interest','loan-repay','delete-coll','delete-task','delete-ach','delete-domain','delete-prod','delete-shopcat','exempt','unlock','archive'];
    ll.innerHTML=state.logs.slice(0,100).map(l=>{
      const isBoth=l.st==='both';
      const cls=l.amt>0?'pos'+(isBoth||l.st==='progress'?' p':l.st==='achievement'?' a':''):l.amt<0?'neg':'zero';
      const dotCls=isBoth?'p':l.st==='vitality'?'v':l.st==='progress'?'p':l.st==='achievement'?'a':'s';
      const sign=l.amt>0?'+':'';
      const amtTxt=l.amt!==0?sign+fmt(l.amt):'—';
      const unit=isBoth?' 活力+进度':l.st==='vitality'?' 活力':l.st==='progress'?' 进度':l.st==='achievement'?' 成果':'';
      const canUndo=undoableSrc.includes(l.src);
      return '<div class="log-item">'
        +'<div class="log-dot '+dotCls+'"></div>'
        +'<div class="log-desc">'+esc(l.desc)+'</div>'
        +'<div class="log-amt '+cls+'">'+amtTxt+unit+'</div>'
        +'<div class="log-time">'+fmtTime(l.time)+'</div>'
        +(canUndo?'<button class="log-undo" onclick="undoLog(\''+l.id+'\')">撤销</button>':'')
        +'</div>';
    }).join('');
  }
}

function sumLog(st,pos){
  return state.logs.filter(l=>logHasType(l,st)&&(pos?logAmt(l,st)>0:logAmt(l,st)<0)).reduce((s,l)=>s+logAmt(l,st),0);
}

// ===== Chart state & interactivity =====
var chartState={trendMode:'cumulative',hiddenSeries:{vitality:false,progress:false,achievement:false}};

function toggleChartSeries(type){
  chartState.hiddenSeries[type]=!chartState.hiddenSeries[type];
  // Update legend visual state
  document.querySelectorAll('.ch-legend .clickable').forEach(el=>{
    const map={'活力':'vitality','进度':'progress','成果':'achievement'};
    const t=map[el.textContent.trim()];
    if(t)el.classList.toggle('dimmed',chartState.hiddenSeries[t]);
  });
  drawChart();
}

function toggleTrendMode(){
  chartState.trendMode=chartState.trendMode==='cumulative'?'daily':'cumulative';
  document.getElementById('trendModeBtn').textContent=chartState.trendMode==='cumulative'?'日增':'累积';
  drawChart();
}

function showChartTip(e,html){
  const tip=document.getElementById('chartTooltip');
  tip.innerHTML=html;
  tip.style.display='block';
  tip.style.left=(e.clientX+12)+'px';
  tip.style.top=(e.clientY-10)+'px';
}
function hideChartTip(){
  document.getElementById('chartTooltip').style.display='none';
}

function drawChart(){
  const svg=document.getElementById('trendChart');
  const days=7;
  const today=new Date();today.setHours(0,0,0,0);
  const dayLabels=[],dayStart=[],dayEnd=[];
  for(let i=days-1;i>=0;i--){
    const d=new Date(today);d.setDate(d.getDate()-i);
    dayLabels.push((d.getMonth()+1)+'/'+d.getDate());
    dayStart.push(d.getTime());
    dayEnd.push(d.getTime()+864e5);
  }
  const types=['vitality','progress','achievement'];
  const typeNames={vitality:'活力',progress:'进度',achievement:'成果'};
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colors={vitality:isDark?'#7ab088':'#5b9a6e',progress:isDark?'#7894b5':'#5b7fa8',achievement:isDark?'#c4985c':'#b08640'};
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#aaa';
  const series={};
  types.forEach(type=>{
    series[type]=[];
    if(chartState.trendMode==='cumulative'){
      // Cumulative: sum all logs up to end of each day
      for(let i=0;i<days;i++){
        let cum=0;
        state.logs.forEach(l=>{
          if(logHasType(l,type)&&l.time<dayEnd[i])cum+=logAmt(l,type);
        });
        series[type].push(cum);
      }
    }else{
      // Daily: net change for each specific day
      for(let i=0;i<days;i++){
        let daily=0;
        state.logs.forEach(l=>{
          if(logHasType(l,type)&&l.time>=dayStart[i]&&l.time<dayEnd[i])daily+=logAmt(l,type);
        });
        series[type].push(daily);
      }
    }
  });
  let maxVal=1;
  types.forEach(type=>{
    if(chartState.hiddenSeries[type])return;
    series[type].forEach(v=>{if(Math.abs(v)>maxVal)maxVal=Math.abs(v)});
  });
  const W=700,H=140,padL=36,padR=8,padT=8,padB=22;
  const cW=W-padL-padR,cH=H-padT-padB,stepX=cW/(days-1);
  // Baseline for daily mode (0 is in the middle if there are negatives)
  const hasNeg=chartState.trendMode==='daily'&&types.some(t=>!chartState.hiddenSeries[t]&&series[t].some(v=>v<0));
  const baseline=hasNeg?padT+cH/2:padT+cH;
  function pt(type,i){
    const x=padL+i*stepX;
    const y=baseline-(series[type][i]/maxVal)*(hasNeg?cH/2:cH);
    return[x,y];
  }
  let s='';
  // Grid lines
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    const range=hasNeg?maxVal*2:maxVal;
    const val=Math.round(range-(range/4)*g);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+val+'</text>';
  }
  // Zero line for daily mode
  if(hasNeg){
    s+='<line x1="'+padL+'" y1="'+baseline+'" x2="'+(W-padR)+'" y2="'+baseline+'" stroke="'+(isDark?'#5a5a60':'#ccc')+'" stroke-width="1.5"/>';
  }
  // X axis labels
  dayLabels.forEach((label,i)=>{
    const x=padL+i*stepX;
    s+='<text x="'+x+'" y="'+(H-5)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+label+'</text>';
  });
  // Draw lines and dots for each visible series
  types.forEach(type=>{
    if(chartState.hiddenSeries[type])return;
    let path='';
    series[type].forEach((v,i)=>{
      const[x,y]=pt(type,i);
      path+=(i===0?'M':'L')+x+','+y+' ';
    });
    s+='<path class="svg-line" d="'+path+'" fill="none" stroke="'+colors[type]+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
    series[type].forEach((v,i)=>{
      const[x,y]=pt(type,i);
      const tipHtml=typeNames[type]+' · '+dayLabels[i]+'<br><b>'+fmt(v)+'</b>';
      s+='<circle class="svg-dot" cx="'+x+'" cy="'+y+'" r="3" fill="'+colors[type]+'" onmouseover="showChartTip(event,\''+tipHtml.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    });
  });
  svg.innerHTML=s;
}

function drawVitalityFlowChart(){
  const svg=document.getElementById('flowChart');
  const weeks=4;
  const today=new Date();today.setHours(0,0,0,0);
  // Calculate week boundaries
  const weekRanges=[];
  for(let i=0;i<weeks;i++){
    const end=i===0?today.getTime()+864e5:weekRanges[i-1].start;
    const start=end-7*864e5;
    weekRanges.push({start:start,end:end});
  }
  const weekLabels=weekRanges.map((wr,i)=>{
    if(i===0)return'本周';
    if(i===1)return'上周';
    return(i+1)+'周前';
  });
  // For each week, categorize vitality flow:
  // 产出: vitality earned from check-ins (src='checkin', st='vitality', amt>0)
  // 投资: vitality spent on progress task costs (src='cost', amt<0)
  // 消费: vitality spent on shop purchases (src='purchase', st='vitality', amt<0)
  const produceData=[],investData=[],consumeData=[];
  weekRanges.forEach(wr=>{
    let prod=0,inv=0,cons=0;
    state.logs.forEach(l=>{
      if(l.time>=wr.start&&l.time<wr.end){
        if(l.src==='checkin'&&(l.st==='vitality'||l.st==='both')&&logAmt(l,'vitality')>0)prod+=logAmt(l,'vitality');
        else if(l.src==='cost'&&l.amt<0)inv+=Math.abs(l.amt);
        else if(l.src==='purchase'&&l.st==='vitality'&&l.amt<0)cons+=Math.abs(l.amt);
      }
    });
    produceData.push(prod);
    investData.push(inv);
    consumeData.push(cons);
  });
  const maxVal=Math.max(1,...produceData,...investData,...consumeData);
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorProd=isDark?'#7ab088':'#5b9a6e';
  const colorInv=isDark?'#7894b5':'#5b7fa8';
  const colorCons=isDark?'#c47b6e':'#c2615a';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#aaa';
  const W=700,H=180,padL=36,padR=8,padT=8,padB=30;
  const cW=W-padL-padR,cH=H-padT-padB;
  const groupW=cW/weeks;
  const barW=groupW*0.18;
  const gap=barW*0.25;
  let s='';
  // Grid lines
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    const val=Math.round(maxVal-(maxVal/4)*g);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+val+'</text>';
  }
  // Bars and labels for each week
  weekLabels.forEach((label,i)=>{
    const gc=padL+groupW*i+groupW/2;
    // Production bar (left)
    const pH=(produceData[i]/maxVal)*cH;
    const pX=gc-gap*1.5-barW;
    const pY=padT+cH-pH;
    const pTip='产出 · '+label+'<br><b>'+fmt(produceData[i])+'</b> 活力';
    s+='<rect class="svg-bar" x="'+pX+'" y="'+pY+'" width="'+barW+'" height="'+pH+'" fill="'+colorProd+'" rx="2" onmouseover="showChartTip(event,\''+pTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Investment bar (center)
    const iH=(investData[i]/maxVal)*cH;
    const iX=gc-barW/2;
    const iY=padT+cH-iH;
    const iTip='投资 · '+label+'<br><b>'+fmt(investData[i])+'</b> 活力 → 进度任务';
    s+='<rect class="svg-bar" x="'+iX+'" y="'+iY+'" width="'+barW+'" height="'+iH+'" fill="'+colorInv+'" rx="2" onmouseover="showChartTip(event,\''+iTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Consumption bar (right)
    const cH2=(consumeData[i]/maxVal)*cH;
    const cX=gc+gap*1.5;
    const cY=padT+cH-cH2;
    const cTip='消费 · '+label+'<br><b>'+fmt(consumeData[i])+'</b> 活力 → 商店购买';
    s+='<rect class="svg-bar" x="'+cX+'" y="'+cY+'" width="'+barW+'" height="'+cH2+'" fill="'+colorCons+'" rx="2" onmouseover="showChartTip(event,\''+cTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Week label
    s+='<text x="'+gc+'" y="'+(H-14)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+label+'</text>';
    // Efficiency rate below
    const totalSpend=investData[i]+consumeData[i];
    const rate=totalSpend>0?Math.round(investData[i]/totalSpend*100):0;
    const rateColor=rate>=50?colorInv:colorCons;
    s+='<text x="'+gc+'" y="'+(H-3)+'" text-anchor="middle" font-size="9" fill="'+rateColor+'" font-weight="600">投资率 '+rate+'%</text>';
  });
  // Baseline
  s+='<line x1="'+padL+'" y1="'+(padT+cH)+'" x2="'+(W-padR)+'" y2="'+(padT+cH)+'" stroke="'+(isDark?'#5a5a60':'#ccc')+'" stroke-width="1.5"/>';
  svg.innerHTML=s;
}

function drawWeekCompareChart(){
  const svg=document.getElementById('weekCompareChart');
  if(!svg)return;
  const summaryEl=document.getElementById('weekCompareSummary');
  const weeks=6,anchor=1;
  const today=new Date();today.setHours(0,0,0,0);
  const ranges=[];
  for(let i=weeks-1;i>=0;i--){
    const start=weekStartTs(anchor,today.getTime())-i*7*864e5;
    ranges.push({start:start,end:start+7*864e5});
  }
  const data=ranges.map((r,i)=>{
    const w=weekScore(r.start,r.end);
    const label=i===weeks-1?'本周':i===weeks-2?'上周':((weeks-1-i)+'周前');
    return {label:label,score:w.score,investRate:w.investRate,prog:w.prog,vit:w.vit,ach:w.ach,checkins:w.checkins,invest:w.invest,consume:w.consume};
  });
  const cur=data[weeks-1],prev=data[weeks-2];
  if(summaryEl&&cur&&prev){
    const delta=cur.score-prev.score;
    const cls=delta>0?'up':delta<0?'down':'';
    const arrow=delta>0?'↑':delta<0?'↓':'＝';
    summaryEl.innerHTML='<b>'+fmt(cur.score)+'</b> vs <b>'+fmt(prev.score)+'</b> <span class="'+cls+'">'+arrow+' '+fmt(Math.abs(delta))+'</span>';
  }
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorBar=isDark?'#7894b5':'#5b7fa8';
  const colorNeg=isDark?'#c87060':'#c0564e';
  const colorLine=isDark?'#7ab088':'#5b9a6e';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#aaa';
  let minScore=0,maxScore=1;
  data.forEach(d=>{if(d.score<minScore)minScore=d.score;if(d.score>maxScore)maxScore=d.score;});
  if(minScore>0)minScore=0;
  if(maxScore<=0)maxScore=1;
  const W=700,H=220,padL=42,padR=48,padT=14,padB=26;
  const cW=W-padL-padR,cH=H-padT-padB;
  const groupW=cW/weeks,barW=groupW*0.5;
  const range=(maxScore-minScore)||1;
  const yScore=v=>padT+cH-((v-minScore)/range)*cH;
  const yInvest=v=>padT+cH-(Math.max(0,Math.min(100,v))/100)*cH;
  const xCenter=i=>padL+groupW*i+groupW/2;
  let s='';
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    const val=maxScore-(range/4)*g;
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+fmt(val)+'</text>';
  }
  if(minScore<0){
    const y0=yScore(0);
    s+='<line x1="'+padL+'" y1="'+y0+'" x2="'+(W-padR)+'" y2="'+y0+'" stroke="'+(isDark?'#5a5a60':'#ccc')+'" stroke-width="1.2"/>';
  }
  [['0','0%'],['50','50%'],['100','100%']].forEach(pair=>{
    const y=yInvest(Number(pair[0]));
    s+='<text x="'+(W-padR+6)+'" y="'+(y+3)+'" font-size="9" fill="'+labelColor+'">'+pair[1]+'</text>';
  });
  let ratePath='';
  data.forEach((d,i)=>{
    const x=xCenter(i),y=yInvest(d.investRate);
    ratePath+=(i===0?'M':'L')+x+','+y+' ';
  });
  s+='<path d="'+ratePath+'" fill="none" stroke="'+colorLine+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
  data.forEach((d,i)=>{
    const x=xCenter(i),y=yInvest(d.investRate);
    const rTip=d.label+' 投资率 <b>'+fmt(d.investRate)+'%</b>';
    s+='<circle cx="'+x+'" cy="'+y+'" r="3" fill="'+colorLine+'" onmouseover="showChartTip(event,\''+rTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
  });
  data.forEach((d,i)=>{
    const x=xCenter(i);
    const y0=yScore(0),yy=yScore(d.score);
    const yTop=Math.min(y0,yy),hBar=Math.max(1,Math.abs(yy-y0));
    const fill=d.score<0?colorNeg:colorBar;
    const tip='<b>'+d.label+'</b> 总分 '+fmt(d.score)
      +'<br>进度 +'+fmt(d.prog)+'　活力 '+fmt(d.vit)
      +'<br>成果 +'+fmt(d.ach)+'　打卡 '+d.checkins+'次'
      +'<br>投资 '+fmt(d.invest)+'　消费 '+fmt(d.consume)
      +'<br>投资率 '+fmt(d.investRate)+'%';
    s+='<rect class="svg-bar" x="'+(x-barW/2)+'" y="'+yTop+'" width="'+barW+'" height="'+hBar+'" fill="'+fill+'" rx="2" onmouseover="showChartTip(event,\''+tip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    s+='<text x="'+x+'" y="'+(yTop-4)+'" text-anchor="middle" font-size="9" font-weight="600" fill="'+labelColor+'">'+fmt(d.score)+'</text>';
    s+='<text x="'+x+'" y="'+(H-8)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+d.label+'</text>';
  });
  svg.innerHTML=s;
}

// ===== Render: Radar (domain capability) =====
function renderRadar(){
  const svg=document.getElementById('radarChart');
  const empty=document.getElementById('radarEmpty');
  const metrics=state.metrics||[];
  if(!metrics.length){
    svg.style.display='none';
    empty.style.display='block';
    empty.innerHTML='<p>尚未设定指标，雷达图将按指标汇总领域进度展示</p><button class="btn btn-sm" onclick="openMetricModal()">新建指标</button>';
    return;
  }
  svg.style.display='block';
  empty.style.display='none';
  empty.innerHTML='';
  // Radar rendering
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorMain=isDark?'#7894b5':'#5b7fa8';
  const colorFill=isDark?'rgba(120,148,181,.18)':'rgba(91,127,168,.15)';
  const colorNeg=isDark?'#c87060':'#c0564e';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#888';
  const N=metrics.length;
  const vals=metrics.map(m=>metricValue(m));
  const maxVal=Math.max(1,...vals.map(v=>Math.abs(v)));
  const cx=150,cy=150,R=88;
  const ang=i=>-Math.PI/2+i*(2*Math.PI/N);
  const xyr=(i,r)=>{const a=ang(i);return[cx+Math.cos(a)*r,cy+Math.sin(a)*r]};
  // Radii for grid rings (clamp negatives to 0)
  const rad=i=>Math.max(0,Math.min(1,vals[i]/maxVal))*R;
  let s='';
  // Concentric grid polygons (4 rings)
  for(let ring=1;ring<=4;ring++){
    const rr=R*ring/4;
    let pts='';
    for(let i=0;i<N;i++){const[x,y]=xyr(i,rr);pts+=(i?' ':'')+x+','+y;}
    s+='<polygon points="'+pts+'" fill="none" stroke="'+gridColor+'" stroke-width="1"/>';
    // Ring value label (small, top-left)
    const ringVal=Math.round(maxVal*ring/4*100)/100;
    s+='<text x="'+(cx+8)+'" y="'+(cy-rr)+'" font-size="8" fill="'+labelColor+'">'+fmt(ringVal)+'</text>';
  }
  // Axis lines
  for(let i=0;i<N;i++){
    const[x,y]=xyr(i,R);
    s+='<line x1="'+cx+'" y1="'+cy+'" x2="'+x+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
  }
  // Data polygon
  let dataPts='';
  for(let i=0;i<N;i++){const[x,y]=xyr(i,rad(i));dataPts+=(i?' ':'')+x+','+y;}
  s+='<polygon points="'+dataPts+'" fill="'+colorFill+'" stroke="'+colorMain+'" stroke-width="1.5" stroke-linejoin="round"/>';
  // Vertices + labels + hit areas
  metrics.forEach((m,i)=>{
    const[x,y]=xyr(i,rad(i));
    const neg=vals[i]<0;
    const shortName=m.name.length>6?m.name.slice(0,6)+'…':m.name;
    // Axis name label (outside vertex)
    const lx2=cx+Math.cos(ang(i))*(R+18), ly2=cy+Math.sin(ang(i))*(R+18);
    const anchor=Math.abs(Math.cos(ang(i)))<0.3?'middle':(Math.cos(ang(i))>0?'start':'end');
    s+='<text x="'+lx2+'" y="'+ly2+'" text-anchor="'+anchor+'" font-size="10" fill="'+labelColor+'">'+esc(shortName)+'</text>';
    // Value label (inside/near vertex)
    const vx=cx+Math.cos(ang(i))*(rad(i)+14), vy=cy+Math.sin(ang(i))*(rad(i)+14);
    s+='<text x="'+vx+'" y="'+vy+'" text-anchor="middle" font-size="9" font-weight="600" fill="'+(neg?colorNeg:colorMain)+'">'+fmt(vals[i])+'</text>';
    // Vertex dot
    s+='<circle cx="'+x+'" cy="'+y+'" r="3" fill="'+(neg?colorNeg:colorMain)+'"/>';
    // Hit area for tooltip
    const tip='<b>'+esc(m.name)+'</b><br>总值 '+fmt(vals[i])
      +(m.domainIds||[]).map(did=>'<br>· '+esc(domainName(did))+' '+fmt(domainProgress(did))).join('');
    s+='<circle cx="'+x+'" cy="'+y+'" r="10" fill="transparent" style="cursor:pointer" onmouseover="showChartTip(event,\''+tip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
  });
  svg.innerHTML=s;
}
function renderMetricChips(){
  const mc=document.getElementById('metricChips');
  if(!mc)return;
  const metrics=state.metrics||[];
  let html=metrics.map(m=>{
    const val=metricValue(m);
    const doms=(m.domainIds||[]).map(did=>domainName(did)).join('、');
    return '<div class="metric-chip" onclick="openMetricModal(\''+m.id+'\')" title="领域：'+esc(doms)+'">'
      +'<span class="mc-name">'+esc(m.name)+'</span>'
      +'<span class="mc-val'+(val<0?' neg':'')+'">'+fmt(val)+'</span>'
      +'<button class="mc-del" title="删除指标" onclick="event.stopPropagation();delMetric(\''+m.id+'\')">×</button>'
      +'</div>';
  }).join('');
  html+='<div class="metric-chip add" onclick="openMetricModal()">+ 指标</div>';
  mc.innerHTML=html;
}

// ===== Render: Shop =====
function renderShop(){
  const sV=document.getElementById('sVitality');
  sV.textContent=fmt(state.scores.vitality);
  sV.classList.toggle('neg',state.scores.vitality<0);
  const sA=document.getElementById('sAchievement');
  sA.textContent=fmt(state.scores.achievement);
  sA.classList.toggle('neg',state.scores.achievement<0);

  const sl=document.getElementById('shopList');
  let html='';
  state.shopCategories.forEach(cat=>{
    // Filter out sold-out products (stock===0) — they go to the sold-out section
    const prods=state.products.filter(p=>(p.categoryId||'sc_default')===cat.id&&p.stock!==0);
    const isCollapsed=(state.collapsedShopCats||[]).includes(cat.id);
    html+='<div class="shop-cat-group'+(isCollapsed?' collapsed':'')+'" data-cat-id="'+cat.id+'">';
    // Category header (clickable to toggle collapse)
    html+='<div class="coll-header" onclick="toggleCollapse(\'shop-category\',\''+cat.id+'\')">';
    html+='<div class="coll-name"><span class="coll-toggle">▼</span>'+esc(cat.name)+' <span class="coll-count">'+prods.length+'件</span></div>';
    html+='<div class="coll-actions" onclick="event.stopPropagation()">';
    html+='<span class="drag-handle" title="拖拽分类">⋮⋮</span>';
    html+='<button onclick="openProdModal(null,\''+cat.id+'\')">+ 商品</button>';
    if(cat.id!=='sc_default'){
      html+='<button onclick="renameShopCategory(\''+cat.id+'\')">重命名</button><button onclick="delShopCategory(\''+cat.id+'\')">删除</button>';
    }
    html+='</div>';
    html+='</div>';
    // Body (collapsible)
    html+='<div class="coll-body">';
    if(prods.length===0){
      html+='<div class="empty" style="padding:16px"><p style="margin:0;color:var(--text-3)">暂无商品 · 拖拽 ⋮⋮ 按钮可排序或跨分类移动</p></div>';
    }else{
      html+='<div class="shop-grid">'+prods.map(p=>shopCardHTML(p,cat.id)).join('')+'</div>';
    }
    html+='</div>';
    html+='</div>';
  });

  // Sold-out section
  var soldoutProds=state.products.filter(p=>p.stock===0);
  if(soldoutProds.length>0){
    var isSoldCollapsed=(state.collapsedShopCats||[]).includes('sc_soldout');
    html+='<div class="shop-cat-group'+(isSoldCollapsed?' collapsed':'')+'" data-cat-id="sc_soldout">';
    html+='<div class="coll-header" onclick="toggleCollapse(\'shop-category\',\'sc_soldout\')">';
    html+='<div class="coll-name"><span class="coll-toggle">▼</span>售罄 <span class="coll-count">'+soldoutProds.length+'件</span></div>';
    html+='<div class="coll-actions" onclick="event.stopPropagation()">';
    html+='</div>';
    html+='</div>';
    html+='<div class="coll-body">';

    // Group sold-out products by their original categoryId
    var soldByCat={};
    soldoutProds.forEach(function(p){
      var catId=p.categoryId||'sc_default';
      if(!soldByCat[catId])soldByCat[catId]=[];
      soldByCat[catId].push(p);
    });

    // Render each sub-group
    Object.keys(soldByCat).forEach(function(catId){
      var cat=state.shopCategories.find(function(c){return c.id===catId;});
      var catName=cat?cat.name:'默认';
      var prods=soldByCat[catId];

      // Build category options for the dropdown
      var catOptions=state.shopCategories.map(function(c){
        return '<option value="'+c.id+'"'+(c.id===catId?' selected':'')+'>'+esc(c.name)+'</option>';
      }).join('');

      html+='<div class="soldout-sub" data-prev-cat-id="'+catId+'">';
      html+='<div class="soldout-sub-header">';
      html+='<div class="ss-name"><span class="drag-handle" title="拖拽排序">⋮⋮</span>'+esc(catName)+'</div>';
      html+='<select onchange="changeSoldoutCat(this,\''+catId+'\')">'+catOptions+'</select>';
      html+='</div>';
      html+='<div class="shop-grid">'+prods.map(function(p){return shopCardHTML(p,'sc_soldout',catId);}).join('')+'</div>';
      html+='</div>';
    });

    html+='</div>';
    html+='</div>';
  }

  sl.innerHTML=html;

  const pl=document.getElementById('purchaseList');
  const purchases=state.logs.filter(l=>l.src==='purchase');
  if(!purchases.length){
    pl.innerHTML='<div class="empty" style="padding:24px"><p style="margin:0">暂无购买记录</p></div>';
  }else{
    pl.innerHTML=purchases.slice(0,50).map(l=>{
      const dotCls=l.st==='vitality'?'v':'a';
      return '<div class="log-item"><div class="log-dot '+dotCls+'"></div><div class="log-desc">'+esc(l.desc)+'</div><div class="log-amt neg">'+fmt(l.amt)+'</div><div class="log-time">'+fmtTime(l.time)+'</div><button class="log-undo" onclick="undoLog(\''+l.id+'\')">撤销</button></div>';
    }).join('');
  }
}

// Product card HTML helper
function shopCardHTML(p,catId,prevCatId){
  var isV=p.currency==='vitality';
  var cn=isV?'活力点':'成果点';
  var balance=state.scores[p.currency];
  var willLoan=balance<p.price;
  var isSoldout=p.stock===0;
  var stockTxt=p.stock===-1?'':p.stock===0?' · 售罄':' · 库存'+p.stock;
  var debtTxt=(p.debtRate||0)>0?' · 债率'+fmt(p.debtRate)+'%/天':'';
  var loanWarn=willLoan&&!isSoldout?' · 贷款'+fmt(p.price-balance):'';
  var soldoutCls=isSoldout?' soldout':'';
  var dataPrevCat=prevCatId?' data-prev-cat-id="'+prevCatId+'"':'';
  return '<div class="shop-card'+soldoutCls+'" data-prod-id="'+p.id+'" data-cat-id="'+catId+'"'+dataPrevCat+'>'
    +'<div class="card-top" style="margin-bottom:0"><div class="sh-name">'+esc(p.name)+'</div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序或跨分类移动">⋮⋮</span><button onclick="openProdModal(\''+p.id+'\')">编辑</button><button class="del" onclick="confirmDelProd(\''+p.id+'\')">删除</button></div></div>'
    +(p.desc?'<div class="sh-desc">'+esc(p.desc)+'</div>':'')
    +'<div class="sh-cost '+(isV?'v':'a')+'">'+fmt(p.price)+'<span class="unit">'+cn+stockTxt+debtTxt+loanWarn+'</span></div>'
    +(isSoldout?'<div class="sh-buy" style="text-align:center;font-size:12px;color:var(--text-3);padding:8px">售罄</div>'
      :'<button class="btn btn-sm sh-buy" onclick="buyProduct(\''+p.id+'\')">'+(willLoan?'贷款购买':'购买')+'</button>')
    +'</div>';
}

// Change sold-out product's original category (sub-grouping)
function changeSoldoutCat(sel,oldCatId){
  var newCatId=sel.value;
  // Move all sold-out products from oldCatId to newCatId
  state.products.forEach(function(p){
    if(p.stock===0&&(p.categoryId||'sc_default')===oldCatId){
      p.categoryId=newCatId;
    }
  });
  save();
  render();
  toast('售罄商品分类已更新');
}

// ===== Render All =====
function render(){renderWork();renderBank();renderShop();renderCycle();updateExemptChip();initStageBars()}

// ===== Cycle Settings (周期活动) =====
function fmtDate(ts){
  if(!ts)return '—';
  const d=new Date(ts);
  const today=new Date();today.setHours(0,0,0,0);
  const diffDays=Math.round((ts-today.getTime())/864e5);
  if(diffDays===0)return '今天';
  if(diffDays===1)return '明天';
  if(diffDays===2)return '后天';
  return(d.getMonth()+1)+'/'+d.getDate();
}
function cycleNextGrant(cfg){
  const anchor=cfg.anchor||1;
  if(cfg.period==='day'){const d=new Date();d.setHours(0,0,0,0);return d.getTime()+864e5;}
  if(cfg.period==='month'){const d=new Date();return new Date(d.getFullYear(),d.getMonth()+1,1).getTime();}
  const d=new Date();d.setHours(0,0,0,0);
  const dow=(d.getDay()+6)%7+1;
  let diff=anchor-dow;if(diff<=0)diff+=7;
  return d.getTime()+diff*864e5;
}
function updateExemptChip(){
  const chip=document.getElementById('exemptChip');
  if(!chip)return;
  const bal=state.cards.exemption||0;
  chip.style.display=bal>0?'inline-flex':'none';
  chip.textContent='豁免卡 × '+bal;
}
function periodLabel(p){return p==='day'?'每天':p==='month'?'每月':'每周';}
const COND_METRICS=[
  {v:'checkins',n:'打卡次数'},
  {v:'vitality',n:'活力点'},
  {v:'progress',n:'进度值'},
  {v:'achievement',n:'成果点'},
  {v:'new_tasks',n:'新增任务'},
  {v:'new_domains',n:'新增领域'}
];
const COND_TARGET_TYPES=[{v:'all',n:'全部'},{v:'domain',n:'按领域'},{v:'task',n:'按任务'}];
const COND_NEW_FILTERS=[{v:'none',n:'当前'},{v:'new_task',n:'本周期新增任务'},{v:'new_domain',n:'本周期新增领域'}];
const COND_AGGREGATES=[{v:'sum',n:'总计'},{v:'any',n:'任意单个'}];
// 主体类型：成果点仅全部；计数类(新增任务/新增领域)支持全部+领域；值类(打卡/活力/进度)支持全部+领域+任务
function condTargetTypesFor(metric){
  if(metric==='achievement')return ['all'];
  if(metric==='new_tasks'||metric==='new_domains')return ['all','domain'];
  return ['all','domain','task'];
}
// 新增筛选选项（仅值类指标；按主体限制可用项）
function condNewFilterOptions(targetType){
  if(targetType==='all')return ['none','new_task','new_domain'];
  if(targetType==='domain')return ['none','new_task'];
  return ['none'];
}
function rangeLabel(range,days){
  if(range==='recent')return '最近'+(days||7)+'天';
  const r=COND_RANGES.find(x=>x.v===range);
  return r?r.n:'本周期';
}
function metricNameLabel(it){
  return (COND_METRICS.find(m=>m.v===it.metric)||{}).n||it.metric;
}
function condEntityWord(it){
  return it.newFilter==='new_domain'?'领域':'任务';
}
// 是否多实体语境（需要展示「总计/任意单个」聚合方式）
function condIsMulti(it){
  if(it.newFilter==='new_task'||it.newFilter==='new_domain')return true;
  if(it.targetType==='all'&&it.aggregate==='any')return true;
  return false;
}
// 主体+新增短语（不含范围与聚合）
function condScopePhrase(it){
  const t=it.target||'';
  if(it.newFilter==='new_task'){
    if(it.targetType==='domain'&&t)return domainName(t)+'新增任务';
    return '新增任务';
  }
  if(it.newFilter==='new_domain')return '新增领域';
  if(it.targetType==='domain'&&t)return domainName(t);
  if(it.targetType==='task'&&t)return taskNameLabel(t);
  return '';
}
function metricLabel(it){
  const mn=metricNameLabel(it);
  let s=condScopePhrase(it);
  if(condIsMulti(it))s+=(it.aggregate==='any'?'·任一'+condEntityWord(it):'·总计');
  return (s?s+'·':'')+mn;
}
function opLabel(op){return {'<=':'≤','>=':'≥','>':'>','<':'<'}[op]||'≥';}
function rangeTimeWord(it,act){
  if(it.range==='today')return '今天';
  if(it.range==='recent')return '最近'+(it.days||7)+'天';
  if(it.range==='total')return '累计';
  if(act.period==='day')return '昨日';
  if(act.period==='month')return '上月';
  return '上周';
}
function condItemLabel(it){
  if(!it)return '';
  return rangeLabel(it.range,it.days)+' · '+metricLabel(it)+' '+opLabel(it.op)+' '+fmt(it.value);
}
function condNodeLabel(node){
  if(node&&node.group)return '（'+((node.items||[]).map(condNodeLabel).join(node.mode==='any'?' 或 ':' 且 '))+'）';
  return condItemLabel(node);
}
function condNLLeaf(it,act){
  const rw=rangeTimeWord(it,act);
  const mn=metricNameLabel(it);
  const tail=' '+opLabel(it.op)+' '+fmt(it.value);
  if(it.metric==='achievement')return rw+mn+tail;
  const scope=condScopePhrase(it);
  const ew=condEntityWord(it);
  const anyAgg=it.aggregate==='any';
  if(it.newFilter==='new_task'||it.newFilter==='new_domain'){
    if(anyAgg)return rw+scope+'中，任意单个'+ew+mn+tail;
    return rw+scope+'总计'+mn+tail;
  }
  if(it.targetType==='all'){
    if(anyAgg)return rw+'任意单个'+ew+mn+tail;
    return rw+mn+tail;
  }
  if(anyAgg)return rw+scope+'中，任意单个'+ew+mn+tail;
  return rw+scope+mn+tail;
}
function condNLNode(node,act){
  if(node&&node.group)return '（'+((node.items||[]).map(n=>condNLNode(n,act)).join(node.mode==='any'?' 或 ':' 且 '))+'）';
  return condNLLeaf(node,act);
}
function rewardItemLabel(it){
  if(!it)return '';
  if(it.type==='card')return cardName(it.card||'exemption')+' ×'+(it.amount||0)+(it.cap?'（上限'+(it.cap||0)+'）':'');
  if(it.type==='progress'){
    if(it.domainId)return domainName(it.domainId)+'进度 +'+fmt(it.amount);
    return '进度(全领域) +'+fmt(it.amount);
  }
  if(it.type==='vitality'){
    const tName=it.taskId?(state.tasks.find(t=>t.id===it.taskId)||{}).name:'';
    return tName?('「'+tName+'」活力 +'+fmt(it.amount)):('活力 +'+fmt(it.amount));
  }
  if(it.type==='achievement')return '成果 +'+fmt(it.amount);
  return '';
}
function actMetaLabel(a){
  const c=a.condition||{mode:'all',items:[]};
  const condItems=c.items||[];
  const condTxt=condItems.length?condItems.map(condNodeLabel).join(c.mode==='any'?' 或 ':' 且 '):'无条件';
  const resItems=(a.result&&a.result.items)||[];
  const resTxt=resItems.length?resItems.map(rewardItemLabel).join('、'):'无';
  return '前提：'+condTxt+'　结果：'+resTxt;
}
function readRewardItems(){
  const rewardItems=[];
  document.querySelectorAll('#activityResultDetails .reward-row').forEach(row=>{
    const type=row.querySelector('.rr-type').value;
    const amount=Math.max(0,Number(row.querySelector('.rr-amount').value)||0);
    if(amount<=0&&type!=='card')return;
    if(type==='card'){
      rewardItems.push({type:'card',card:'exemption',amount:Math.round(amount),cap:Math.max(1,Math.round(Number(row.querySelector('.rr-cap').value)||3))});
    }else if(type==='progress'){
      const did=row.querySelector('.rr-domain').value;
      const r={type:'progress',amount:amount};
      if(did)r.domainId=did;
      rewardItems.push(r);
    }else if(type==='vitality'){
      const tid=row.querySelector('.rr-task').value;
      const r={type:'vitality',amount:amount};
      if(tid)r.taskId=tid;
      rewardItems.push(r);
    }else if(type==='achievement'){
      rewardItems.push({type:'achievement',amount:amount});
    }
  });
  return rewardItems;
}
function updateCondPreview(){
  const el=document.getElementById('condPreview');
  if(!el)return;
  const items=condDraft.items||[];
  const mode=condDraft.mode==='any'?'any':'all';
  const period=document.getElementById('activityPeriod').value;
  const anchor=parseInt(document.getElementById('activityAnchor').value,10)||1;
  const anchorNames=['','周一','周二','周三','周四','周五','周六','周日'];
  const when=period==='day'?'每天结算时':period==='month'?'每月结算时':('每'+anchorNames[anchor]+'结算时');
  const actLike={period:period};
  let condTxt;
  if(!items.length)condTxt='无条件触发';
  else condTxt=items.map(n=>condNLNode(n,actLike)).join(mode==='any'?' 或 ':' 且 ');
  const rewards=readRewardItems();
  const resTxt=rewards.length?rewards.map(rewardItemLabel).join('、'):'（未设置奖励）';
  el.innerHTML='<span class="cp-badge">预览</span>'+esc(when)+'，若 '+esc(condTxt)+'，则发放 '+esc(resTxt)+'。';
}
function openActivityModal(id){
  const a=id?state.activities.find(x=>x.id===id):null;
  document.getElementById('activityId').value=id||'';
  document.getElementById('activityModalTitle').textContent=id?'编辑周期活动':'新建周期活动';
  document.getElementById('activityName').value=a?a.name:'';
  document.getElementById('activityPeriod').value=a?a.period:'week';
  document.getElementById('activityAnchor').value=a?(a.anchor||1):1;
  condDraft=normalizeCondition((a&&a.condition)||{mode:'all',items:[]});
  document.getElementById('activityCondMode').value=(condDraft.mode==='any')?'any':'all';
  document.getElementById('activityDeleteBtn').style.display=id?'':'none';
  renderActivityResultDetails(a?a.result:null);
  renderCondTree();
  activityPeriodChanged();
  // 折叠分区：基本信息展开，前提与奖励默认收起以保持简洁（标题栏显示摘要）
  setAcc('accBasic',true);
  setAcc('accCond',false);
  setAcc('accResult',false);
  updateActivitySummary();
  openModal('activityModal');
  setTimeout(()=>document.getElementById('activityName').focus(),50);
}
function activityPeriodChanged(){
  const p=document.getElementById('activityPeriod').value;
  document.getElementById('activityAnchorFg').style.display=(p==='week')?'':'none';
  updateCondPreview();
  updateActivitySummary();
}
function toggleAcc(id){const el=document.getElementById(id);if(el)el.classList.toggle('open');}
function setAcc(id,open){const el=document.getElementById(id);if(el)el.classList.toggle('open',open);}
function updateActivitySummary(){
  const periodSel=document.getElementById('activityPeriod');
  if(periodSel){
    const p=periodSel.value;
    const anchorNames=['','周一','周二','周三','周四','周五','周六','周日'];
    const a=parseInt(document.getElementById('activityAnchor').value,10)||1;
    const basicSum=document.getElementById('accBasicSum');
    if(basicSum)basicSum.textContent=p==='week'?('每周 · '+anchorNames[a]):periodLabel(p);
  }
  const condMode=document.getElementById('activityCondMode');
  const condSum=document.getElementById('accCondSum');
  if(condSum){
    const n=countCondLeaves(condDraft.items||[]);
    const m=(condMode&&condMode.value==='any')?'任一':'全部';
    condSum.textContent=n?((m==='任一'?'任一满足':'全部满足')+' · '+n+' 项'):'无条件';
  }
  const resBox=document.getElementById('activityResultDetails');
  const resSum=document.getElementById('accResultSum');
  if(resSum&&resBox){
    const n=resBox.querySelectorAll('.reward-row').length;
    resSum.textContent=n?(n+' 项奖励'):'未设置';
  }
}
// ===== 条件芯片编辑器（嵌套条件组 + 点选面板）=====
function countCondLeaves(items){
  return (items||[]).reduce((s,node)=>{
    if(node&&node.group)return s+countCondLeaves(node.items);
    return s+1;
  },0);
}
function condListAt(parentPath){
  if(!parentPath)return condDraft.items;
  const parts=parentPath.split('/').map(Number);
  let list=condDraft.items;
  for(const idx of parts){
    const node=list[idx];
    if(!node||!node.group)return condDraft.items;
    list=node.items;
  }
  return list;
}
function condNodeAt(path){
  if(!path)return null;
  const parts=path.split('/').filter(Boolean).map(Number);
  let list=condDraft.items;
  let node=null;
  for(let i=0;i<parts.length;i++){
    const idx=parts[i];
    if(idx<0||idx>=list.length)return null;
    node=list[idx];
    if(node&&node.group)list=node.items;
  }
  return node;
}
function condMetricChipText(it){
  return rangeLabel(it.range,it.days)+' · '+metricLabel(it);
}
function condItemRow(it,path){
  it=it||{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'};
  return '<div class="cond-chip-line">'
    +'<button class="cc-chip cc-metric" title="点击修改指标" onclick="openCondMetricPanel(\''+path+'\',this)">'+esc(condMetricChipText(it))+'</button>'
    +'<button class="cc-chip cc-op" title="点击修改运算符" onclick="openCondOpPanel(\''+path+'\',this)">'+esc(opLabel(it.op))+'</button>'
    +'<button class="cc-chip cc-value" title="点击修改数值" onclick="editCondValue(\''+path+'\',this)">'+esc(fmt(it.value))+'</button>'
    +'<button class="cc-del" title="删除此条件" onclick="removeCondNode(\''+path+'\')">×</button>'
    +'</div>';
}
function condGroupInnerHTML(group,path,depth){
  const items=group.items||[];
  if(!items.length)return '<div class="cond-empty-sm">组内还没有条件</div>';
  return renderCondNodes(items,path,depth+1);
}
function condGroupHTML(group,path,depth){
  const canNest=depth<1;
  return '<div class="cond-group">'
    +'<div class="cond-group-head">'
    +'<span class="cg-label">满足</span>'
    +'<select class="cg-mode" onchange="changeGroupMode(\''+path+'\',this.value)">'
    +'<option value="all"'+(group.mode==='any'?'':' selected')+'>全部</option>'
    +'<option value="any"'+(group.mode==='any'?' selected':'')+'>任意</option>'
    +'</select>'
    +'<span class="cg-label2">以下条件</span>'
    +'<button class="cc-del" title="删除此条件组" onclick="removeCondNode(\''+path+'\')">×</button>'
    +'</div>'
    +'<div class="cond-group-body">'
    +condGroupInnerHTML(group,path,depth)
    +'<div class="cond-actions">'
    +'<button class="btn btn-sm" onclick="addCondItem(\''+path+'\')">+ 添加条件</button>'
    +(canNest?'<button class="btn btn-sm" onclick="addCondGroup(\''+path+'\')">+ 添加条件组</button>':'')
    +'</div>'
    +'</div></div>';
}
function renderCondNodes(items,parentPath,depth){
  return (items||[]).map((node,idx)=>{
    const path=parentPath?parentPath+'/'+idx:String(idx);
    return (node&&node.group)?condGroupHTML(node,path,depth):condItemRow(node,path);
  }).join('');
}
function renderCondTree(){
  const box=document.getElementById('activityCondItems');
  if(!box)return;
  box.innerHTML=(condDraft.items&&condDraft.items.length)?renderCondNodes(condDraft.items,'',0):'<div class="cond-empty">还没有条件，满足任意情况即触发</div>';
  updateCondPreview();
  updateActivitySummary();
}
function addCondItem(parentPath){condListAt(parentPath).push({range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'});renderCondTree();}
function addCondGroup(parentPath){condListAt(parentPath).push({group:true,mode:'all',items:[{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all'}]});renderCondTree();}
function removeCondNode(path){
  if(!path)return;
  const parts=path.split('/').map(Number);
  const idx=parts.pop();
  const parentPath=parts.join('/');
  const list=condListAt(parentPath);
  if(list&&idx>=0&&idx<list.length)list.splice(idx,1);
  renderCondTree();
}
function changeGroupMode(path,mode){
  const node=condNodeAt(path);
  if(node&&node.group)node.mode=(mode==='any'?'any':'all');
  renderCondTree();
}
function onCondModeChange(){
  condDraft.mode=document.getElementById('activityCondMode').value==='any'?'any':'all';
  updateCondPreview();
  updateActivitySummary();
}
// ===== 点选浮层面板 =====
function getCondPanelEl(){
  let el=document.getElementById('condPanel');
  if(!el){
    el=document.createElement('div');
    el.id='condPanel';
    el.className='cond-panel';
    document.body.appendChild(el);
  }
  return el;
}
function positionCondPanel(anchor){
  const el=getCondPanelEl();
  el.style.visibility='hidden';
  el.style.display='block';
  const r=anchor.getBoundingClientRect();
  const pw=el.offsetWidth||200;
  const ph=el.offsetHeight||0;
  const vw=window.innerWidth,vh=window.innerHeight;
  const left=Math.max(8,Math.min(r.left,vw-pw-8));
  let top=r.bottom+6;
  if(top+ph>vh-8)top=r.top-ph-6;
  if(top<8)top=8;
  el.style.left=left+'px';
  el.style.top=top+'px';
  el.style.visibility='visible';
}
function renderCondPanel(){
  const el=getCondPanelEl();
  const p=condPanel;
  let html='';
  if(p.kind==='op'){
    html='<div class="cp-title">运算符</div><div class="cp-opts">';
    [['>=','≥'],['>','>'],['<=','≤'],['<','<']].forEach(o=>{
      html+='<button class="cp-opt" onclick="commitCondOp(\''+o[0]+'\')">'+o[1]+'</button>';
    });
    html+='</div>';
  }else if(p.step==='range'){
    html='<div class="cp-title">时间范围</div><div class="cp-opts">';
    COND_RANGES.forEach(r=>{
      html+='<button class="cp-opt" onclick="pickCondRange(\''+r.v+'\')">'+r.n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='days'){
    html='<div class="cp-title">最近多少天</div><div class="cp-days">'
      +'<input type="number" id="condPanelDays" value="'+p.days+'" min="1" step="1">'
      +'<button class="btn btn-sm" onclick="confirmCondDays()">确定</button></div>';
  }else if(p.step==='metric'){
    html='<div class="cp-title">指标</div><div class="cp-opts">';
    COND_METRICS.forEach(m=>{
      html+='<button class="cp-opt" onclick="pickCondMetric(\''+m.v+'\')">'+m.n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='targetType'){
    html='<div class="cp-title">统计主体</div><div class="cp-opts">';
    condTargetTypesFor(p.metric).forEach(tt=>{
      const n=(COND_TARGET_TYPES.find(x=>x.v===tt)||{}).n||tt;
      html+='<button class="cp-opt" onclick="pickCondTargetType(\''+tt+'\')">'+n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='newFilter'){
    html='<div class="cp-title">新增筛选</div><div class="cp-opts">';
    condNewFilterOptions(p.targetType).forEach(nf=>{
      const n=(COND_NEW_FILTERS.find(x=>x.v===nf)||{}).n||nf;
      html+='<button class="cp-opt" onclick="pickCondNewFilter(\''+nf+'\')">'+n+'</button>';
    });
    html+='</div>';
  }else if(p.step==='domain'){
    html='<div class="cp-title">选择领域</div><div class="cp-opts">';
    state.domains.forEach(d=>{
      html+='<button class="cp-opt" onclick="pickCondDomain(\''+d.id+'\')">'+esc(d.name)+'</button>';
    });
    html+='</div>';
  }else if(p.step==='task'){
    html='<div class="cp-title">选择任务</div><div class="cp-opts">';
    state.tasks.forEach(t=>{
      html+='<button class="cp-opt" onclick="pickCondTask(\''+t.id+'\')">'+esc(t.name)+'</button>';
    });
    html+='</div>';
  }else if(p.step==='aggregate'){
    html='<div class="cp-title">聚合方式</div><div class="cp-opts">';
    COND_AGGREGATES.forEach(a=>{
      html+='<button class="cp-opt" onclick="pickCondAggregate(\''+a.v+'\')">'+a.n+'</button>';
    });
    html+='</div>';
  }
  el.innerHTML=html;
  if(p.kind==='metric'&&p.step==='days'){
    setTimeout(()=>{const inp=document.getElementById('condPanelDays');if(inp){inp.focus();inp.select();}},0);
  }
}
function openCondMetricPanel(path,anchor){
  const it=condNodeAt(path)||{range:'period',metric:'checkins',op:'>=',value:1,targetType:'all',newFilter:'none',target:'',aggregate:'sum'};
  condPanel={visible:true,kind:'metric',path:path,anchor:anchor,step:'range',range:it.range||'period',days:it.days||7,metric:it.metric||'checkins',targetType:it.targetType||'all',newFilter:it.newFilter||'none',target:it.target||'',aggregate:it.aggregate||'sum'};
  renderCondPanel();
  positionCondPanel(anchor);
}
function openCondOpPanel(path,anchor){
  condPanel={visible:true,kind:'op',path:path,anchor:anchor,step:'range',range:'period',days:7,metric:'checkins',targetType:'all',newFilter:'none',target:'',aggregate:'sum'};
  renderCondPanel();
  positionCondPanel(anchor);
}
function pickCondRange(range){
  condPanel.range=range;
  condPanel.step=(range==='recent')?'days':'metric';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function confirmCondDays(){
  const inp=document.getElementById('condPanelDays');
  condPanel.days=Math.max(1,Math.round(Number(inp&&inp.value)||7));
  condPanel.step='metric';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondMetric(metric){
  condPanel.metric=metric;
  // 成果点仅支持「全部」，直接提交
  if(metric==='achievement'){commitCondValue('all','','none','sum');return;}
  condPanel.step='targetType';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondTargetType(tt){
  condPanel.targetType=tt;
  // 单任务：主体即锁定唯一实体，无需新增筛选与聚合
  if(tt==='task'){
    condPanel.newFilter='none';
    condPanel.step='task';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
    return;
  }
  // 计数类指标（新增任务/新增领域）：本身已限定「新增」，无需新增筛选/聚合
  if(condPanel.metric==='new_tasks'||condPanel.metric==='new_domains'){
    if(tt==='all'){commitCondValue('all','','none','sum');}
    else{condPanel.step='domain';renderCondPanel();positionCondPanel(condPanel.anchor);}
    return;
  }
  // 值类指标（打卡/活力/进度）：全部→新增筛选；按领域→先选领域再新增筛选
  condPanel.step=(tt==='all')?'newFilter':'domain';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondNewFilter(nf){
  condPanel.newFilter=nf;
  condPanel.step='aggregate';
  renderCondPanel();
  positionCondPanel(condPanel.anchor);
}
function pickCondDomain(id){
  condPanel.target=id;
  // 计数类指标选完领域即完成；值类指标继续选新增筛选
  if(condPanel.metric==='new_tasks'||condPanel.metric==='new_domains'){
    commitCondValue('domain',id,'none','sum');
  }else{
    condPanel.step='newFilter';
    renderCondPanel();
    positionCondPanel(condPanel.anchor);
  }
}
function pickCondTask(id){
  commitCondValue('task',id,'none','sum');
}
function pickCondAggregate(agg){
  commitCondValue(condPanel.targetType,condPanel.target,condPanel.newFilter,agg);
}
function commitCondValue(targetType,target,newFilter,aggregate){
  const it=condNodeAt(condPanel.path);
  if(it&&!it.group){
    it.range=condPanel.range;
    if(condPanel.range==='recent')it.days=condPanel.days;else delete it.days;
    it.metric=condPanel.metric;
    it.targetType=targetType;
    if(targetType==='all')delete it.target;else it.target=target;
    it.newFilter=newFilter;
    it.aggregate=aggregate;
  }
  closeCondPanel();
  renderCondTree();
}
function commitCondOp(op){
  const it=condNodeAt(condPanel.path);
  if(it&&!it.group)it.op=op;
  closeCondPanel();
  renderCondTree();
}
function closeCondPanel(){
  condPanel.visible=false;
  const el=document.getElementById('condPanel');
  if(el){el.style.display='none';el.innerHTML='';}
}
function editCondValue(path,btn){
  const it=condNodeAt(path);
  if(!it||it.group)return;
  const valChip=btn.closest('.cond-chip-line').querySelector('.cc-value');
  if(!valChip)return;
  const input=document.createElement('input');
  input.type='number';
  input.className='cc-value-input';
  input.value=it.value;
  input.step='0.1';
  let done=false;
  const commit=()=>{
    if(done)return;
    done=true;
    const v=Number(input.value);
    it.value=(v!==undefined&&!isNaN(v))?v:0;
    renderCondTree();
  };
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();commit();}
    else if(e.key==='Escape'){done=true;renderCondTree();}
  });
  input.addEventListener('blur',commit);
  valChip.replaceWith(input);
  input.focus();
  input.select();
}
document.addEventListener('click',function(e){
  if(!condPanel.visible)return;
  // 用 composedPath 判定：面板内部点击后按钮可能因 innerHTML 重渲染脱离 DOM，
  // 此时 e.target.closest 会返回 null；composedPath 仍保留派发时的祖先链，可正确识别面板内点击。
  const path=(e.composedPath&&e.composedPath())||[];
  const inPanel=path.some(n=>n&&n.getAttribute&&n.getAttribute('id')==='condPanel');
  const inChip=path.some(n=>n&&n.classList&&n.classList.contains('cc-chip'));
  if(!inPanel&&!inChip)closeCondPanel();
});
function rewardRowHTML(item){
  item=item||{type:'vitality',amount:10};
  const typeOpts=[['vitality','活力点'],['progress','进度值'],['achievement','成果点'],['card','断更豁免卡']]
    .reduce((s,o)=>s+'<option value="'+o[0]+'"'+((item.type||'vitality')===o[0]?' selected':'')+'>'+o[1]+'</option>','');
  const domOpts='<option value="">全部领域</option>'+state.domains.map(d=>'<option value="'+d.id+'"'+((item.domainId||'')===d.id?' selected':'')+'>'+esc(d.name)+'</option>').join('');
  const taskOpts='<option value="">不指定任务</option>'+state.tasks.map(t=>'<option value="'+t.id+'"'+((item.taskId||'')===t.id?' selected':'')+'>'+esc(t.name)+'</option>').join('');
  const isVit=(item.type==='vitality');
  const isProg=(item.type==='progress');
  const isCard=(item.type==='card');
  return '<div class="reward-row">'
    +'<select class="rr-type" onchange="rrTypeChanged(this)">'+typeOpts+'</select>'
    +'<select class="rr-task" style="display:'+(isVit?'':'none')+'" title="关联任务（可选）">'+taskOpts+'</select>'
    +'<select class="rr-domain" style="display:'+(isProg?'':'none')+'" title="关联领域（可选）">'+domOpts+'</select>'
    +'<input type="number" class="rr-amount" value="'+(item.amount||10)+'" min="0" step="0.1" title="数量">'
    +'<input type="number" class="rr-cap" value="'+(item.cap||3)+'" min="1" step="1" style="display:'+(isCard?'':'none')+'" title="豁免卡累计上限">'
    +'<button class="rr-del" onclick="removeRewardRow(this)">×</button>'
    +'</div>';
}
function renderActivityResultDetails(result){
  const box=document.getElementById('activityResultDetails');
  result=result||{};
  const items=(result.items&&result.items.length)?result.items:[{type:'vitality',amount:10}];
  box.innerHTML=items.map(rewardRowHTML).join('');
}
function addRewardRow(){
  const box=document.getElementById('activityResultDetails');
  const tmp=document.createElement('div');
  tmp.innerHTML=rewardRowHTML({type:'vitality',amount:10});
  box.appendChild(tmp.firstChild);
  updateActivitySummary();
}
function removeRewardRow(btn){btn.closest('.reward-row').remove();updateActivitySummary();}
function rrTypeChanged(sel){
  const row=sel.closest('.reward-row');
  const dom=row.querySelector('.rr-domain');
  const task=row.querySelector('.rr-task');
  const cap=row.querySelector('.rr-cap');
  const m=sel.value;
  task.style.display=(m==='vitality')?'':'none';
  dom.style.display=(m==='progress')?'':'none';
  cap.style.display=(m==='card')?'':'none';
}
function validateDomain(id){return state.domains.some(d=>d.id===id)?id:'d_default'}
function handleActivitySave(){
  const id=document.getElementById('activityId').value;
  const name=document.getElementById('activityName').value.trim();
  if(!name){toast('请输入活动名称','err');return}
  const period=document.getElementById('activityPeriod').value;
  const anchor=parseInt(document.getElementById('activityAnchor').value,10)||1;
  condDraft.mode=document.getElementById('activityCondMode').value==='any'?'any':'all';
  const condition=condDraft;
  const rewardItems=readRewardItems();
  const result={items:rewardItems};
  if(!rewardItems.length){toast('请至少添加一个有效的奖励项','err');return}
  if(id){
    const idx=state.activities.findIndex(x=>x.id===id);
    if(idx<0){toast('活动不存在','err');return}
    const prev=state.activities[idx];
    state.activities[idx]={id:id,name:name,enabled:prev.enabled,period:period,anchor:anchor,condition:condition,result:result,lastRun:prev.lastRun};
  }else{
    state.activities.push({id:uid(),name:name,enabled:true,period:period,anchor:anchor,condition:condition,result:result,lastRun:null});
  }
  save();
  closeModal('activityModal');
  processActivities();
  toast(id?'活动已更新':'活动已创建');
  render();
}
function toggleActivity(id,enabled){
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  a.enabled=enabled;
  save();
  processActivities();
  render();
  toast(enabled?'活动已开始运行':'活动已停止');
}
let pendingDeleteActivityId=null;
function askDelActivity(id){
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  pendingDeleteActivityId=id;
  document.getElementById('activityDeleteMsg').innerHTML='活动「'+esc(a.name)+'」将被删除。<br><span style="color:var(--text-3);font-size:11px">「撤销历史获得」会回收该活动已发放的活力点 / 进度值 / 成果点与豁免卡。</span>';
  openModal('activityDeleteModal');
}
function askDelActivityFromModal(){
  const id=document.getElementById('activityId').value;
  closeModal('activityModal');
  askDelActivity(id);
}
function doDeleteActivity(revoke){
  const id=pendingDeleteActivityId;
  pendingDeleteActivityId=null;
  closeModal('activityDeleteModal');
  const a=state.activities.find(x=>x.id===id);
  if(!a)return;
  if(revoke)revokeActivityGrants(id);
  state.activities=state.activities.filter(x=>x.id!==id);
  save();render();
  toast(revoke?'活动已删除，历史获得已撤销':'活动已删除');
}
function revokeActivityGrants(actId){
  const logs=state.logs.filter(l=>l.actId===actId);
  let cardUndo=0;
  logs.forEach(l=>{
    if(l.src==='reward'){
      const amt=Number(l.amt)||0;
      if(l.st==='vitality')state.scores.vitality=(state.scores.vitality||0)-amt;
      else if(l.st==='achievement')state.scores.achievement=(state.scores.achievement||0)-amt;
      else if(l.st==='progress'){const did=l.dom||'d_default';state.scores.progress[did]=(state.scores.progress[did]||0)-amt;}
    }else if(l.src==='card-grant'){
      cardUndo+=(typeof l.granted==='number'?l.granted:parseCardGrantAmt(l.desc));
    }
  });
  if(cardUndo>0)state.cards.exemption=Math.max(0,(state.cards.exemption||0)-cardUndo);
  state.logs=state.logs.filter(l=>l.actId!==actId);
}
function parseCardGrantAmt(desc){
  const m=/(\d+)\s*张/.exec(desc||'');return m?parseInt(m[1],10):0;
}
function renderExemptPanel(){
  const box=document.getElementById('exemptUsePanel');
  if(!box)return;
  const cards=state.cards.exemption||0;
  const exAct=exemptionActivity();
  const ruleEnabled=!!(exAct&&exAct.enabled);
  const today=new Date();today.setHours(0,0,0,0);
  const eligible=state.tasks.filter(t=>{
    if(t.archived)return false;
    const checkedToday=!!(t.lastCheckIn&&new Date(t.lastCheckIn)>=today);
    const exemptToday=!!(t.lastExempt&&new Date(t.lastExempt)>=today);
    return !checkedToday&&!exemptToday;
  });
  const selOpts=eligible.map(t=>{
    const lastEff=effectiveLastTs(t);
    let gapDays=0;
    if(lastEff){const prev=new Date(lastEff);prev.setHours(0,0,0,0);gapDays=Math.round((today-prev)/864e5);}
    const label=t.name+(gapDays>=2?'  ·  已断更'+(gapDays-1)+'天':'');
    return '<option value="'+t.id+'">'+esc(label)+'</option>';
  }).join('');
  const canUse=ruleEnabled&&cards>0&&eligible.length>0;
  box.innerHTML=
    '<div class="act-head"><div class="act-name">断更豁免卡 <span class="badge">剩余 '+cards+' 张</span></div></div>'
    +(ruleEnabled?'':'<div class="sec-note" style="color:var(--danger)">当前没有「发放豁免卡」的运行中活动，请先在上方新建并启用一个奖励豁免卡的周期活动。</div>')
    +(ruleEnabled&&cards<=0?'<div class="sec-note">暂无可用豁免卡，待周期结算自动发放后即可使用。</div>':'')
    +'<div class="reward-row" style="margin-top:10px">'
    +'<select id="exemptTaskSel" style="flex:1">'+(selOpts||'<option value="">暂无可豁免任务</option>')+'</select>'
    +'<button class="btn btn-sm btn-exempt" style="width:auto" onclick="useExemptionFromSel()" '+(canUse?'':'disabled')+'>使用豁免</button>'
    +'</div>'
    +'<div class="sec-note">事前「请假」：今天不打卡仍延续连胜利率；事后「补救」：已断更则清零待扣债。使用不消耗活力、不增加进度。</div>';
}
function useExemptionFromSel(){
  const sel=document.getElementById('exemptTaskSel');
  if(!sel||!sel.value){toast('请先选择要豁免的任务','warn');return;}
  useExemption(sel.value);
}
function renderCycle(){
  const acts=state.activities||[];
  const total=acts.length;
  const enabledActs=acts.filter(a=>a.enabled);
  const bal=state.cards.exemption||0;

  const cardGrants=enabledActs.flatMap(a=>(a.result&&a.result.items||[]).filter(it=>it.type==='card'));
  const cardTotal=cardGrants.reduce((s,it)=>s+(it.amount||0),0);
  const cardCap=cardGrants.length?Math.max.apply(null,cardGrants.map(it=>it.cap||1)):0;
  document.getElementById('cyCardBal').textContent=bal;
  document.getElementById('cyCardSub').textContent=cardGrants.length?('每周期发放 '+cardTotal+' 张'+(cardCap?' · 上限 '+cardCap:'')):'未配置豁免卡活动';

  document.getElementById('cyGranted').textContent=enabledActs.length;
  document.getElementById('cyGrantedSub').textContent='共 '+total+' 个活动'+(enabledActs.length<total?' · 停用 '+(total-enabledActs.length)+' 个':'  ·  全部运行中');

  let next=null;const nextActs=[];
  enabledActs.forEach(a=>{
    const t=cycleNextGrant(a);
    if(t===null)return;
    if(next===null||t<next){next=t;nextActs.length=0;nextActs.push(a);}
    else if(t===next)nextActs.push(a);
  });
  document.getElementById('cyNext').textContent=next!==null?fmtDate(next):'—';
  const nextSub=document.getElementById('cyNextSub');
  nextSub.textContent=next!==null?(nextActs.length===1?('结算「'+nextActs[0].name+'」'):('将结算 '+nextActs.length+' 个活动')):'无运行中的活动';

  const box=document.getElementById('cycleActivities');
  if(!acts.length){
    box.innerHTML='<div class="empty"><p>尚未创建周期活动</p><button class="btn btn-sm" onclick="openActivityModal()">新建活动</button></div>';
  }else{
    box.innerHTML=acts.map(a=>{
      const stateTxt=a.enabled?'运行中':'已停用';
      const stateColor=a.enabled?'var(--progress)':'var(--text-3)';
      return '<div class="rule-card">'
        +'<div class="act-head">'
        +'<div class="act-name">'+esc(a.name)+' <span class="badge">'+periodLabel(a.period)+'</span>'
        +'<span style="font-size:10px;color:'+stateColor+'">'+stateTxt+'</span></div>'
        +'<div class="act-ctrls">'
        +'<label class="switch" title="运行／停止" onclick="event.stopPropagation()"><input type="checkbox" '+(a.enabled?'checked':'')+' onchange="toggleActivity(\''+a.id+'\',this.checked)"><span class="slider"></span></label>'
        +'<span class="act-switch-lbl">'+(a.enabled?'运行':'停止')+'</span>'
        +'<button class="btn btn-sm" onclick="openActivityModal(\''+a.id+'\')">编辑详情</button>'
        +'</div>'
        +'</div>'
        +'<div class="act-meta">'+actMetaLabel(a)+'</div>'
        +'</div>';
    }).join('');
  }

  renderExemptPanel();
}

// ===== Inline toggle =====
// Filter tasks by domain (clicking a domain pill)
function filterByDomain(domId){
  if(state.filterDomain===domId){
    state.filterDomain=null; // click again to clear filter
  }else{
    state.filterDomain=domId;
  }
  save();
  renderWork();
  renderBank();
}

function toggleInline(id){
  const el=document.getElementById(id);
  el.style.display=el.style.display==='none'?'flex':'none';
  if(el.style.display!=='none'){
    const inp=el.querySelector('input');
    if(inp)setTimeout(()=>inp.focus(),30);
  }
}

// ===== Collapse toggle =====
function toggleCollapse(type,id){
  var arr;
  if(type==='collection')arr=state.collapsedColls;
  else if(type==='ach-domain')arr=state.collapsedAchDoms;
  else if(type==='shop-category')arr=state.collapsedShopCats;
  else{ // legacy: treat as collection
    arr=state.collapsedColls;
    id=type;
  }
  if(!arr)arr=[];
  var i=arr.indexOf(id);
  if(i>=0)arr.splice(i,1);
  else arr.push(id);
  if(type==='collection')state.collapsedColls=arr;
  else if(type==='ach-domain')state.collapsedAchDoms=arr;
  else if(type==='shop-category')state.collapsedShopCats=arr;
  save();
  // Toggle DOM without full re-render for smoothness
  var selector;
  if(type==='ach-domain')selector='.ach-dom-group[data-dom-id="'+id+'"]';
  else if(type==='shop-category')selector='.shop-cat-group[data-cat-id="'+id+'"]';
  else selector='.coll-group[data-coll-id="'+id+'"]'; // collection or legacy
  var group=document.querySelector(selector);
  if(group)group.classList.toggle('collapsed');
}

// ===== Drag-and-drop (generic, long-press to reorder) =====
let drag={active:false,type:null,id:null,groupId:null,el:null,ghost:null,indicator:null,timer:null,
  startX:0,startY:0,originRect:null,offsetX:0,offsetY:0,pointerId:null};
let dragJustEnded=false;

function initDrag(){
  document.addEventListener('pointerdown',onDragDown);
  document.addEventListener('pointermove',onDragMove);
  document.addEventListener('pointerup',onDragUp);
  document.addEventListener('pointercancel',onDragUp);
  // Suppress click events that fire right after a drag (e.g. on collapsible headers)
  document.addEventListener('click',function(e){
    if(dragJustEnded){e.preventDefault();e.stopPropagation();}
  },true);
}

function getDragTarget(target){
  // Don't interfere with modals or interactive elements
  if(target.closest('.modal-bg.show'))return null;

  // Only start drag from a .drag-handle or .drag-handle-h element
  var handle=target.closest('.drag-handle,.drag-handle-h');
  if(!handle)return null;

  // 1. Task card
  var taskCard=handle.closest('.card[data-task-id]');
  if(taskCard)return{el:taskCard,type:'task',id:taskCard.dataset.taskId,groupId:taskCard.dataset.collId};

  // 2. Milestone card
  var achCard=handle.closest('.card[data-ach-id]');
  if(achCard)return{el:achCard,type:'milestone',id:achCard.dataset.achId,groupId:achCard.dataset.domId};

  // 3. Product card
  var prodCard=handle.closest('.shop-card[data-prod-id]');
  if(prodCard)return{el:prodCard,type:'product',id:prodCard.dataset.prodId,groupId:prodCard.dataset.catId};

  // 4. Collection group (handle is inside the header)
  var collGroup=handle.closest('.coll-group[data-coll-id]');
  if(collGroup)return{el:collGroup,type:'collection',id:collGroup.dataset.collId,groupId:null};

  // 5. Achievement domain group
  var achDomGroup=handle.closest('.ach-dom-group[data-dom-id]');
  if(achDomGroup)return{el:achDomGroup,type:'ach-domain',id:achDomGroup.dataset.domId,groupId:null};

  // 6. Shop category group
  var shopCatGroup=handle.closest('.shop-cat-group[data-cat-id]');
  if(shopCatGroup)return{el:shopCatGroup,type:'shop-category',id:shopCatGroup.dataset.catId,groupId:null};

  return null;
}

function onDragDown(e){
  if(drag.active)return;
  var target=getDragTarget(e.target);
  if(!target)return;

  drag.type=target.type;
  drag.id=target.id;
  drag.groupId=target.groupId;
  drag.el=target.el;
  drag.startX=e.clientX;
  drag.startY=e.clientY;
  drag.pointerId=e.pointerId;

  // Start drag immediately (no long-press timer needed)
  drag.active=true;
  target.el.classList.add('dragging');
  document.body.style.overflow='hidden';

  // Cache the element's position ONCE at drag start
  drag.originRect=target.el.getBoundingClientRect();
  drag.offsetX=drag.startX-drag.originRect.left;
  drag.offsetY=drag.startY-drag.originRect.top;

  drag.ghost=target.el.cloneNode(true);
  drag.ghost.classList.add('drag-ghost');
  drag.ghost.classList.remove('dragging');
  drag.ghost.style.width=drag.originRect.width+'px';
  drag.ghost.style.left=drag.originRect.left+'px';
  drag.ghost.style.top=drag.originRect.top+'px';
  document.body.appendChild(drag.ghost);

  drag.indicator=document.createElement('div');
  drag.indicator.className='drag-indicator';

  // Capture pointer to ensure we keep receiving events
  if(e.pointerId!==undefined&&target.el.setPointerCapture){
    try{target.el.setPointerCapture(e.pointerId);}catch(err){}
  }

  toast('拖拽中…松手放置','warn');
}

function getDragSiblings(){
  var type=drag.type,groupId=drag.groupId;
  if(type==='task'){
    return[].slice.call(document.querySelectorAll('#taskGroups .card[data-task-id][data-coll-id="'+groupId+'"]:not(.dragging)'));
  }else if(type==='milestone'){
    return[].slice.call(document.querySelectorAll('#achGroups .card[data-ach-id][data-dom-id="'+groupId+'"]:not(.dragging)'));
  }else if(type==='product'){
    // Allow cross-category drag: return ALL product cards across all categories
    return[].slice.call(document.querySelectorAll('.shop-card[data-prod-id]:not(.dragging)'));
  }else if(type==='collection'){
    return[].slice.call(document.querySelectorAll('#taskGroups .coll-group[data-coll-id]:not(.dragging)'));
  }else if(type==='ach-domain'){
    return[].slice.call(document.querySelectorAll('#achGroups .ach-dom-group[data-dom-id]:not(.dragging)'));
  }else if(type==='shop-category'){
    return[].slice.call(document.querySelectorAll('.shop-cat-group[data-cat-id]:not(.dragging)'));
  }
  return[];
}

function onDragMove(e){
  if(!drag.active)return;
  e.preventDefault();

  // Position ghost using cached offset — ghost follows the finger precisely
  drag.ghost.style.left=(e.clientX-drag.offsetX)+'px';
  drag.ghost.style.top=(e.clientY-drag.offsetY)+'px';

  var siblings=getDragSiblings();
  if(drag.indicator&&drag.indicator.parentNode)drag.indicator.parentNode.removeChild(drag.indicator);

  // Only place indicator among siblings that share the same parent as the dragged element
  var validSiblings=siblings.filter(function(s){
    // For products, allow placing in ANY shop-grid (cross-category)
    if(drag.type==='product')return s.classList&&s.classList.contains('shop-card');
    // For other types, require same parent
    return s.parentNode===drag.el.parentNode;
  });

  var indicatorPlaced=false;
  for(var i=0;i<validSiblings.length;i++){
    var r=validSiblings[i].getBoundingClientRect();
    var mid=r.top+r.height/2;
    if(e.clientY<mid){
      validSiblings[i].parentNode.insertBefore(drag.indicator,validSiblings[i]);
      indicatorPlaced=true;
      break;
    }
  }
  if(!indicatorPlaced&&validSiblings.length>0){
    var last=validSiblings[validSiblings.length-1];
    last.parentNode.insertBefore(drag.indicator,last.nextSibling);
  }
}

function onDragUp(e){
  if(!drag.active)return;

  // Release pointer capture
  if(drag.pointerId!==undefined&&drag.el&&drag.el.releasePointerCapture){
    try{drag.el.releasePointerCapture(drag.pointerId);}catch(err){}
  }

  var type=drag.type;
  var groupId=drag.groupId;
  var indicator=drag.indicator;
  var insertBefore=indicator?indicator.nextSibling:null;

  // For products: allow cross-category drops into any .shop-grid
  // For other types: only allow within same parent
  var validDrop=false;
  var targetCatId=groupId; // for products, will be updated if dropped in different category

  if(type==='product'){
    // Find which category group the indicator landed in
    var targetGrid=null;
    if(indicator){
      targetGrid=indicator.parentNode;
    }
    if(targetGrid&&targetGrid.classList.contains('shop-grid')){
      // Find the ancestor .shop-cat-group or .soldout-subgroup
      var catGroup=targetGrid.closest('.shop-cat-group[data-cat-id]');
      if(catGroup){
        targetCatId=catGroup.dataset.catId;
      }
      // Move the DOM element to the target grid
      if(insertBefore&&insertBefore.parentNode===targetGrid){
        targetGrid.insertBefore(drag.el,insertBefore);
      }else{
        targetGrid.appendChild(drag.el);
      }
      validDrop=true;
    }
  }else{
    // Other types: only move within same parent
    if(insertBefore&&indicator.parentNode===drag.el.parentNode){
      insertBefore.parentNode.insertBefore(drag.el,insertBefore);
      validDrop=true;
    }else if(indicator&&indicator.parentNode===drag.el.parentNode){
      indicator.parentNode.appendChild(drag.el);
      validDrop=true;
    }
  }
  // If invalid drop (indicator in wrong container), don't move the element

  drag.el.classList.remove('dragging');
  // Restore scrolling
  document.body.style.overflow='';
  if(drag.ghost){drag.ghost.remove();drag.ghost=null;}
  if(drag.indicator){drag.indicator.remove();drag.indicator=null;}

  // Suppress the click that follows pointerup after a drag
  dragJustEnded=true;
  setTimeout(function(){dragJustEnded=false;},150);

  // Persist new order only if the drop was valid
  if(validDrop){
    if(type==='task')saveTaskOrderFromDOM(groupId);
    else if(type==='collection')saveCollectionOrderFromDOM();
    else if(type==='milestone')saveAchOrderFromDOM(groupId);
    else if(type==='ach-domain')saveAchDomOrderFromDOM();
    if(type==='product'){
      // 关键：跨分类移动后，被拖拽卡片本身的 data-cat-id 仍是旧分类，
      // 导致 saveProdOrderFromDOM(新分类) 查询不到它、却已把 state 里的 categoryId 改成新分类，
      // 最终在重排时被丢弃（尤其从「售罄」区拖出时没有第二次回捞）。此处先同步属性再持久化。
      if(drag.el&&targetCatId!=='sc_soldout'){
        drag.el.setAttribute('data-cat-id',targetCatId);
      }
      // Check if product moved to a different category
      var prod=state.products.find(function(p){return p.id===drag.id;});
      if(prod){
        if(targetCatId==='sc_soldout'){
          // Dropped in sold-out section — find target sub-group category via the card's new parent
          var soldoutSub=(drag.el&&drag.el.parentNode)?drag.el.parentNode.closest('.soldout-sub[data-prev-cat-id]'):null;
          if(soldoutSub){
            var targetPrevCat=soldoutSub.dataset.prevCatId;
            if(prod.categoryId!==targetPrevCat){
              prod.categoryId=targetPrevCat;
            }
          }
        }else{
          // Dropped into a normal category — update categoryId
          prod.categoryId=targetCatId;
        }
      }
      // Save order and re-render
      if(targetCatId==='sc_soldout'){
        // For sold-out section, just save and re-render (order within sub-groups)
        save();
      }else{
        saveProdOrderFromDOM(targetCatId);
        if(targetCatId!==groupId&&groupId!=='sc_soldout'){
          saveProdOrderFromDOM(groupId);
        }
      }
      render();
    }
    else if(type==='shop-category')saveShopCatOrderFromDOM();
  }else{
    // Invalid drop — re-render to restore correct DOM
    render();
  }

  drag.active=false;
  drag.el=null;
  drag.type=null;
  drag.id=null;
  drag.groupId=null;
  drag.originRect=null;
  drag.pointerId=null;
}

function saveTaskOrderFromDOM(collId){
  var cards=document.querySelectorAll('.card[data-task-id][data-coll-id="'+collId+'"]');
  var orderedIds=[].slice.call(cards).map(function(c){return c.dataset.taskId;});
  var collTasks={};
  state.tasks.forEach(function(t){collTasks[t.id]=t;});
  var newOrder=[];
  var collIdx=0;
  state.tasks.forEach(function(t){
    if((t.collectionId||'c_default')===collId||(collId==='_none'&&!state.collections.find(function(c){return c.id===t.collectionId;}))){
      if(collIdx<orderedIds.length&&collTasks[orderedIds[collIdx]]){
        newOrder.push(collTasks[orderedIds[collIdx]]);
        collIdx++;
      }
    }else{
      newOrder.push(t);
    }
  });
  while(collIdx<orderedIds.length){
    if(collTasks[orderedIds[collIdx]])newOrder.push(collTasks[orderedIds[collIdx]]);
    collIdx++;
  }
  state.tasks=newOrder;
  save();
  toast('任务顺序已更新');
}

function saveCollectionOrderFromDOM(){
  var groups=document.querySelectorAll('#taskGroups .coll-group[data-coll-id]');
  var orderedIds=[].slice.call(groups).map(function(g){return g.dataset.collId;});
  var map={};
  state.collections.forEach(function(c){map[c.id]=c;});
  state.collections=orderedIds.map(function(id){return map[id];}).filter(Boolean);
  save();
  toast('集合顺序已更新');
}

function saveAchDomOrderFromDOM(){
  var groups=document.querySelectorAll('.ach-dom-group[data-dom-id]');
  var orderedIds=[].slice.call(groups).map(function(g){return g.dataset.domId;});
  var map={};
  state.domains.forEach(function(d){map[d.id]=d;});
  var reordered=orderedIds.map(function(id){return map[id];}).filter(Boolean);
  // Append any domains not rendered (e.g. empty domains)
  state.domains.forEach(function(d){
    if(orderedIds.indexOf(d.id)<0)reordered.push(d);
  });
  state.domains=reordered;
  save();
  toast('领域顺序已更新');
}

function saveAchOrderFromDOM(domId){
  var cards=document.querySelectorAll('.card[data-ach-id][data-dom-id="'+domId+'"]');
  var orderedIds=[].slice.call(cards).map(function(c){return c.dataset.achId;});
  var map={};
  state.achievements.forEach(function(a){map[a.id]=a;});
  var newOrder=[];
  var idx=0;
  state.achievements.forEach(function(a){
    if(a.domainId===domId){
      if(idx<orderedIds.length&&map[orderedIds[idx]]){
        newOrder.push(map[orderedIds[idx]]);
        idx++;
      }
    }else{
      newOrder.push(a);
    }
  });
  while(idx<orderedIds.length){
    if(map[orderedIds[idx]])newOrder.push(map[orderedIds[idx]]);
    idx++;
  }
  state.achievements=newOrder;
  save();
  toast('里程碑顺序已更新');
}

function saveProdOrderFromDOM(catId){
  var cards=document.querySelectorAll('.shop-card[data-prod-id][data-cat-id="'+catId+'"]');
  var orderedIds=[].slice.call(cards).map(function(c){return c.dataset.prodId;});
  var map={};
  state.products.forEach(function(p){map[p.id]=p;});
  var newOrder=[];
  var idx=0;
  state.products.forEach(function(p){
    if((p.categoryId||'sc_default')===catId){
      if(idx<orderedIds.length&&map[orderedIds[idx]]){
        newOrder.push(map[orderedIds[idx]]);
        idx++;
      }
    }else{
      newOrder.push(p);
    }
  });
  while(idx<orderedIds.length){
    if(map[orderedIds[idx]])newOrder.push(map[orderedIds[idx]]);
    idx++;
  }
  state.products=newOrder;
  save();
  toast('商品顺序已更新');
}

function saveShopCatOrderFromDOM(){
  var groups=document.querySelectorAll('.shop-cat-group[data-cat-id]');
  var orderedIds=[].slice.call(groups).map(function(g){return g.dataset.catId;});
  var map={};
  state.shopCategories.forEach(function(c){map[c.id]=c;});
  state.shopCategories=orderedIds.map(function(id){return map[id];}).filter(Boolean);
  save();
  toast('分类顺序已更新');
}

// ===== Undo log entry =====
function undoLog(logId){
  const log=state.logs.find(l=>l.id===logId);
  if(!log){toast('记录不存在','err');return}

  if(log.src==='checkin'){
    // Reverse the score gain (handles 'vitality' / 'progress' / 'both')
    applyCheckinGain(log,-1);
    // Decrement task stats
    if(log.taskId){
      const t=state.tasks.find(x=>x.id===log.taskId);
      if(t){
        t.checkInCount=Math.max(0,(t.checkInCount||0)-1);
        const earnedAmt=(log.st==='both'||log.st==='progress')?logAmt(log,'progress'):logAmt(log,'vitality');
        t.totalEarned=(t.totalEarned||0)-earnedAmt;
        // Restore previous streak, lastCheckIn, lastDebtDate, and pendingDebt
        t.streak=log.prevStreak||0;
        t.lastCheckIn=log.prevLastCheckIn||null;
        if(log.prevLastDebtDate){
          t.lastDebtDate=log.prevLastDebtDate;
        }else{
          delete t.lastDebtDate;
        }
        t.pendingDebt=log.prevPendingDebt||0;
      }
    }
    // Also reverse any linked cost log (restore vitality)
    const costLogs=state.logs.filter(l=>(l.link||'')===logId);
    costLogs.forEach(cl=>{
      state.scores.vitality-=cl.amt;
    });
    // Remove the check-in log and any linked cost log
    state.logs=state.logs.filter(l=>l.id!==logId&&(l.link||'')!==logId);
    toast('已撤销打卡');
  }else if(log.src==='cost'){
    // If cost has a link, undo the parent check-in instead
    if(log.link){
      undoLog(log.link);
      return;
    }
    // Standalone cost — just reverse
    state.scores.vitality-=log.amt;
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销');
  }else if(log.src==='purchase'){
    // Refund and restore stock
    state.scores[log.st]=(state.scores[log.st]||0)+Math.abs(log.amt);
    if(log.prodId){
      const p=state.products.find(x=>x.id===log.prodId);
      if(p){
        // Restore stock even if sold out (stock===0) so it returns to its original category
        if(p.stock>=0)p.stock++;
        p.sold=Math.max(0,(p.sold||0)-1);
      }
    }
    // Also remove any associated loan
    if(log.loanId){
      state.loans=state.loans.filter(l=>l.id!==log.loanId);
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销购买');
  }else if(log.src==='achievement'){
    // Un-unlock achievement
    if(log.achId){
      const a=state.achievements.find(x=>x.id===log.achId);
      if(a){
        a.unlocked=false;
        a.unlockedAt=null;
      }
    }
    state.scores.achievement-=log.amt;
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销成就解锁');
  }else if(log.src==='loan-interest'){
    // Reverse loan interest
    state.scores[log.st]-=log.amt;
    if(log.loanId){
      const loan=state.loans.find(l=>l.id===log.loanId);
      if(loan)loan.amount-=Math.abs(log.amt);
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销利息');
  }else if(log.src==='loan-repay'){
    // Undo loan repayment: restore the repaid amount and re-create the loan
    state.scores[log.st]=(state.scores[log.st]||0)+Math.abs(log.amt);
    if(log.loanCopy){
      // Re-create the loan that was auto-paid
      state.loans.push(log.loanCopy);
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销还款，贷款已恢复');
  }else if(log.src==='delete-coll'){
    // Restore deleted collection
    if(log.collCopy){
      // Restore collection at its original position
      state.collections.splice(Math.min(log.collIndex,state.collections.length),0,log.collCopy);
    }
    // Restore tasks to the collection
    if(log.affectedTasks){
      log.affectedTasks.forEach(at=>{
        const t=state.tasks.find(x=>x.id===at.id);
        if(t)t.collectionId=at.prevCollectionId;
      });
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销删除集合');
  }else if(log.src==='delete-task'){
    // Restore the deleted task
    if(log.taskCopy){
      state.tasks.splice(Math.min(log.taskIndex,state.tasks.length),0,log.taskCopy);
    }
    // Reverse progress move: take back from default, return to original domains
    if(log.progressMoved){
      state.scores.progress['d_default']=(state.scores.progress['d_default']||0)-log.progressMoved.totalMoved;
      log.progressMoved.fromDomains.forEach(d=>{
        state.scores.progress[d.did]=(state.scores.progress[d.did]||0)+d.amount;
      });
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销删除任务');
  }else if(log.src==='delete-ach'){
    // Restore the deleted milestone
    if(log.achCopy){
      state.achievements.splice(Math.min(log.achIndex,state.achievements.length),0,log.achCopy);
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销删除里程碑');
  }else if(log.src==='delete-domain'){
    // Restore the deleted domain
    if(log.domCopy){
      state.domains.splice(Math.min(log.domIndex,state.domains.length),0,log.domCopy);
    }
    // Reverse progress merge: take back from default, return to original domain
    if(log.progressVal){
      state.scores.progress['d_default']=(state.scores.progress['d_default']||0)-log.progressVal;
      state.scores.progress[log.domCopy.id]=log.progressVal;
    }
    // Restore tasks' domain assignments
    if(log.affectedTasks){
      log.affectedTasks.forEach(at=>{
        const t=state.tasks.find(x=>x.id===at.id);
        if(t){
          if(at.prevDomainIds)t.domainIds=at.prevDomainIds;
          if(at.prevDomainId)t.domainId=at.prevDomainId;
        }
      });
    }
    // Restore achievements' domain assignments
    if(log.affectedAchs){
      log.affectedAchs.forEach(aa=>{
        const a=state.achievements.find(x=>x.id===aa.id);
        if(a)a.domainId=aa.prevDomainId;
      });
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销删除领域');
  }else if(log.src==='delete-prod'){
    // Restore the deleted product
    if(log.prodCopy){
      state.products.splice(Math.min(log.prodIndex,state.products.length),0,log.prodCopy);
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销删除商品');
  }else if(log.src==='delete-shopcat'){
    // Restore the deleted shop category
    if(log.catCopy){
      state.shopCategories.splice(Math.min(log.catIndex,state.shopCategories.length),0,log.catCopy);
    }
    // Restore products' category assignments
    if(log.affectedProducts){
      log.affectedProducts.forEach(ap=>{
        const p=state.products.find(x=>x.id===ap.id);
        if(p)p.categoryId=ap.prevCategoryId;
      });
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销删除分类');
  }else if(log.src==='exempt'){
    // Undo exemption: return card + restore pendingDebt/lastExempt/lastDebtDate
    state.cards.exemption=(state.cards.exemption||0)+1;
    if(log.taskId){
      const t=state.tasks.find(x=>x.id===log.taskId);
      if(t){
        if(log.prevLastExempt)t.lastExempt=log.prevLastExempt;else delete t.lastExempt;
        t.pendingDebt=log.prevPendingDebt||0;
        if(log.prevLastDebtDate)t.lastDebtDate=log.prevLastDebtDate;else delete t.lastDebtDate;
      }
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销豁免');
  }else if(log.src==='unlock'){
    // Undo unlock: re-archive task + refund vitality
    state.scores.vitality=(state.scores.vitality||0)-log.amt;
    if(log.taskId){
      const t=state.tasks.find(x=>x.id===log.taskId);
      if(t){t.archived=true;t.archivedAt=now();}
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销解锁，任务已重新归档');
  }else if(log.src==='archive'){
    // Undo auto-archive: un-archive task
    if(log.taskId){
      const t=state.tasks.find(x=>x.id===log.taskId);
      if(t){t.archived=false;delete t.archivedAt;}
    }
    state.logs=state.logs.filter(l=>l.id!==logId);
    toast('已撤销归档');
  }else{
    toast('该记录不支持撤销','err');
    return;
  }

  save();
  checkAchievements();
  processDailyTaskDebts();
  processLoans();
  render();
}

// ===== Modals =====
function openModal(id){document.getElementById(id).classList.add('show')}
function closeModal(id){document.getElementById(id).classList.remove('show')}

function openTaskModal(id,presetCollId){
  const title=document.getElementById('taskModalTitle');
  document.getElementById('taskId').value='';
  fillCollectionSelect(document.getElementById('taskCollection'),presetCollId||'c_default');
  fillDomainChecklist(document.getElementById('taskDomainList'),['d_default']);
  if(id){
    const t=state.tasks.find(x=>x.id===id);
    if(!t)return;
    title.textContent='编辑任务';
    document.getElementById('taskId').value=id;
    document.getElementById('taskName').value=t.name;
    document.getElementById('taskDesc').value=t.description||'';
    document.getElementById('taskInitial').value=t.initialValue;
    document.getElementById('taskInterest').value=t.interestRate;
    document.getElementById('taskDebt').value=t.debtRate;
    document.getElementById('taskCost').value=t.vitalityCost||0;
    fillCollectionSelect(document.getElementById('taskCollection'),t.collectionId||'c_default');
    fillDomainChecklist(document.getElementById('taskDomainList'),getTaskDomainIds(t));
    editTypes=taskScoreTypes(t).slice();
    applyScoreTypePicks();
    // Always offer recalculation when editing; hint reflects whether history exists
    const hasHistory=(t.checkInCount||0)>0||state.logs.some(l=>l.src==='checkin'&&l.taskId===t.id);
    document.getElementById('recalcFG').style.display='block';
    document.getElementById('recalcHint').textContent=hasHistory?('用新参数重放全部 '+(t.checkInCount||0)+' 次打卡记录'):'该任务暂无打卡历史';
    document.getElementById('taskRecalc').checked=false;
  }else{
    title.textContent='新建任务';
    document.getElementById('taskName').value='';
    document.getElementById('taskDesc').value='';
    document.getElementById('taskInitial').value=10;
    document.getElementById('taskInterest').value=10;
    document.getElementById('taskDebt').value=5;
    document.getElementById('taskCost').value=0;
    editTypes=['vitality'];
    applyScoreTypePicks();
    document.getElementById('recalcFG').style.display='none';
  }
  // 初始化阶段奖励编辑状态
  const taskForStage=id?state.tasks.find(x=>x.id===id):null;
  const sr=taskForStage&&taskForStage.stageRewards;
  editStage={enabled:!!sr,v:Array.isArray(sr&&sr.v)?sr.v.slice():[],p:Array.isArray(sr&&sr.p)?sr.p.slice():[],dirtyV:false,dirtyP:false,last:(sr&&typeof sr.last==='number')?sr.last:0};
  const stageCb=document.getElementById('taskStageEnabled');
  if(stageCb)stageCb.checked=editStage.enabled;
  if(editStage.enabled){const rf=document.getElementById('recalcFG');if(rf)rf.style.display='none';}
  renderStageRows();
  refreshTaskSliders();
  setTaskAccordion('accTaskType',true);
  setTaskAccordion('accTaskNum',false);
  setTaskAccordion('accTaskMeta',false);
  setTaskAccordion('accTaskStage',false);
  updateTaskAccSummaries();
  openModal('taskModal');
  setTimeout(()=>document.getElementById('taskName').focus(),50);
}

// ===== 任务弹窗：数值滑动条 + 分区摘要 =====
const TASK_SLIDERS={taskInitial:{min:0,max:100},taskInterest:{min:0,max:50},taskDebt:{min:0,max:50},taskCost:{min:0,max:100}};
function refreshTaskSliders(){
  document.querySelectorAll('.slide-track').forEach(function(track){
    const input=document.getElementById(track.dataset.for);
    if(!input)return;
    const r=TASK_SLIDERS[track.dataset.for]||{min:0,max:100};
    const v=Math.max(r.min,Math.min(r.max,Number(input.value)||0));
    const fill=track.querySelector('.slide-fill');
    if(fill)fill.style.width=(((v-r.min)/(r.max-r.min))*100)+'%';
  });
}
function bindTaskSliders(){
  let cur=null;
  function setFromX(track,clientX){
    const input=document.getElementById(track.dataset.for);
    if(!input)return;
    const rect=track.getBoundingClientRect();
    const r=TASK_SLIDERS[track.dataset.for]||{min:0,max:100};
    let ratio=(clientX-rect.left)/rect.width;
    ratio=Math.max(0,Math.min(1,ratio));
    let v=r.min+ratio*(r.max-r.min);
    v=Math.round(v*10)/10;
    v=Math.max(r.min,Math.min(r.max,v));
    input.value=v;
    const fill=track.querySelector('.slide-fill');
    if(fill)fill.style.width=(ratio*100)+'%';
  }
  document.querySelectorAll('.slide-track').forEach(function(track){
    track.addEventListener('pointerdown',function(e){
      cur=track;
      if(track.setPointerCapture){try{track.setPointerCapture(e.pointerId);}catch(err){}}
      setFromX(track,e.clientX);
    });
    track.addEventListener('pointermove',function(e){
      if(cur===track)setFromX(track,e.clientX);
    });
    track.addEventListener('pointerup',function(){cur=null;});
    track.addEventListener('pointercancel',function(){cur=null;});
  });
  document.addEventListener('input',function(e){
    const id=e.target&&e.target.id;
    if(id&&TASK_SLIDERS[id]){refreshTaskSliders();updateTaskAccSummaries();}
  });
  const collSel=document.getElementById('taskCollection');
  if(collSel)collSel.addEventListener('change',updateTaskAccSummaries);
}
function updateTaskAccSummaries(){
  const tsEl=document.getElementById('accTaskTypeSum');
  if(tsEl){
    const v=editTypes.indexOf('vitality')>=0,p=editTypes.indexOf('progress')>=0;
    let s=(v&&p)?'活力+进度':(p?'进度值':'活力点');
    try{
      if(p){const ds=getCheckedDomainIds();s+=' · '+ds.map(domainName).join('、');}
    }catch(err){}
    tsEl.textContent=s;
  }
  const numEl=document.getElementById('accTaskNumSum');
  if(numEl){
    const g=function(id){const el=document.getElementById(id);return el?el.value:'';};
    numEl.textContent='初始'+g('taskInitial')+' · 利率'+g('taskInterest')+'% · 债率'+g('taskDebt')+'% · 花'+g('taskCost');
  }
  const metaEl=document.getElementById('accTaskMetaSum');
  if(metaEl){
    const sel=document.getElementById('taskCollection');
    metaEl.textContent=(sel&&sel.selectedOptions&&sel.selectedOptions.length)?sel.selectedOptions[0].text:'';
  }
  const stageEl=document.getElementById('accTaskStageSum');
  if(stageEl){
    stageEl.textContent=editStage.enabled?'5 档':'未配置';
  }
}
function setTaskAccordion(id,open){
  const el=document.getElementById(id);
  if(el)el.classList.toggle('open',open);
}

function applyScoreTypePicks(){
  document.getElementById('tpV').classList.toggle('sel',editTypes.indexOf('vitality')>=0);
  document.getElementById('tpP').classList.toggle('sel',editTypes.indexOf('progress')>=0);
  document.getElementById('domainFG').style.display=editTypes.indexOf('progress')>=0?'block':'none';
  renderStageRows();
  updateTaskAccSummaries();
}
function toggleScoreType(type){
  const i=editTypes.indexOf(type);
  if(i>=0){
    if(editTypes.length===1){toast('至少选择一种分值类型','warn');return;}
    editTypes.splice(i,1);
  }else{
    editTypes.push(type);
  }
  applyScoreTypePicks();
}

// ===== 阶段奖励：编辑界面 =====
function onStageEnabled(){
  const cb=document.getElementById('taskStageEnabled');
  editStage.enabled=!!cb.checked;
  if(editStage.enabled){
    const base=parseFloat(document.getElementById('taskInitial').value)||0;
    if(!Array.isArray(editStage.v)||editStage.v.length!==5)editStage.v=[base,base,base,base,base];
    if(!Array.isArray(editStage.p)||editStage.p.length!==5)editStage.p=[base,base,base,base,base];
    editStage.dirtyV=false;editStage.dirtyP=false;
  }
  renderStageRows();
  updateTaskAccSummaries();
}
function onStageInput(type){
  if(type==='vitality')editStage.dirtyV=true;else editStage.dirtyP=true;
  updateTaskAccSummaries();
}
function stageRowHTML(type,label){
  const vals=type==='vitality'?editStage.v:editStage.p;
  const inputs=STAGE_NAMES.map((n,i)=>
    '<div class="stage-cell"><span class="stage-cell-name">'+n+'</span>'
    +'<input type="number" id="stage_'+type+'_'+i+'" value="'+((vals[i]!==undefined&&vals[i]!==null)?vals[i]:'')+'" step="0.1" min="0" oninput="onStageInput(\''+type+'\')"></div>'
  ).join('');
  return '<div class="stage-row">'
    +'<div class="stage-row-head"><span class="stage-row-title">'+label+'</span>'
    +'<div class="sp-group">'
    +'<div class="sp"><button type="button" class="sp-main" onclick="applyStagePreset(\'arith\',\''+type+'\')">等差</button><button type="button" class="sp-arrow" onclick="toggleStageParam(\'arith\',\''+type+'\')">▾</button></div>'
    +'<div class="sp"><button type="button" class="sp-main" onclick="applyStagePreset(\'decr\',\''+type+'\')">缓增</button><button type="button" class="sp-arrow" onclick="toggleStageParam(\'decr\',\''+type+'\')">▾</button></div>'
    +'</div></div>'
    +'<div class="stage-inputs">'+inputs+'</div>'
    +'<div class="sp-panel" id="sp_panel_'+type+'" style="display:none"></div>'
    +'</div>';
}
function renderStageRows(){
  const cont=document.getElementById('taskStageRows');
  if(!cont)return;
  if(!editStage.enabled){cont.innerHTML='';return;}
  const hasV=editTypes.indexOf('vitality')>=0;
  const hasP=editTypes.indexOf('progress')>=0;
  let html='';
  if(hasV)html+=stageRowHTML('vitality','活力点');
  if(hasP)html+=stageRowHTML('progress','进度值');
  cont.innerHTML=html;
}
function toggleStageParam(kind,type){
  const panel=document.getElementById('sp_panel_'+type);
  if(!panel)return;
  const showing=panel.style.display!=='none'&&panel.dataset.kind===kind;
  if(kind==='arith'){
    panel.innerHTML='<div class="sp-param"><label>步长 %</label><input type="number" id="sp_arith_step" value="'+stagePresets.stepPct+'" step="1" min="0"></div><button type="button" class="btn btn-sm" onclick="runStagePreset(\'arith\',\''+type+'\')">生成</button>';
    panel.dataset.kind='arith';
  }else{
    panel.innerHTML='<div class="sp-param"><label>总增幅 %</label><input type="number" id="sp_decr_gain" value="'+stagePresets.decreasePct+'" step="1" min="0"></div><button type="button" class="btn btn-sm" onclick="runStagePreset(\'decr\',\''+type+'\')">生成</button>';
    panel.dataset.kind='decr';
  }
  panel.style.display=showing?'none':'block';
}
function applyStagePreset(kind,type){
  const params=kind==='arith'?{stepPct:stagePresets.stepPct}:{decreasePct:stagePresets.decreasePct};
  generateStage(kind,type,params);
}
function runStagePreset(kind,type){
  if(kind==='arith'){
    stagePresets.stepPct=Number(document.getElementById('sp_arith_step').value)||0;
  }else{
    stagePresets.decreasePct=Number(document.getElementById('sp_decr_gain').value)||0;
  }
  saveStagePresets();
  const params=kind==='arith'?{stepPct:stagePresets.stepPct}:{decreasePct:stagePresets.decreasePct};
  generateStage(kind,type,params);
}
function generateStage(kind,type,params){
  const isV=(type==='vitality');
  let hasVals=false;
  for(let i=0;i<5;i++){const el=document.getElementById('stage_'+type+'_'+i);if(el&&el.value!==''){hasVals=true;break;}}
  if(hasVals&&!window.confirm('这会覆盖当前的 5 个数值，继续吗？'))return;
  const base=parseFloat(document.getElementById('taskInitial').value)||0;
  const vals=kind==='arith'?genArith(base,params.stepPct):genDecr(base,params.decreasePct);
  if(isV){editStage.v=vals;editStage.dirtyV=false;}else{editStage.p=vals;editStage.dirtyP=false;}
  for(let i=0;i<5;i++){
    const el=document.getElementById('stage_'+type+'_'+i);
    if(el)el.value=fmt(vals[i]);
  }
  updateTaskAccSummaries();
}
function genArith(base,stepPct){
  const step=Math.max(0,Number(stepPct)||0)/100;
  return STAGE_NAMES.map((_,n)=>round2(base*(1+step*n)));
}
function genDecr(base,gainPct){
  const total=base*Math.max(0,Number(gainPct)||0)/100;
  const r=0.5,sum=1+r+r*r+r*r*r;
  const d1=total/sum;
  const vals=[round2(base)];
  for(let k=1;k<5;k++){
    let inc=0;
    for(let i=0;i<k;i++)inc+=d1*Math.pow(r,i);
    vals.push(round2(base+inc));
  }
  return vals;
}

function handleTaskSave(){
  const id=document.getElementById('taskId').value;
  const name=document.getElementById('taskName').value.trim();
  const description=document.getElementById('taskDesc').value.trim();
  const initialValue=parseFloat(document.getElementById('taskInitial').value);
  const interestRate=parseFloat(document.getElementById('taskInterest').value);
  const debtRate=parseFloat(document.getElementById('taskDebt').value);
  const vitalityCost=parseFloat(document.getElementById('taskCost').value);
  const collectionId=document.getElementById('taskCollection').value;
  const domainIds=getCheckedDomainIds();

  if(!name){toast('请输入任务名称','err');return}
  if(isNaN(initialValue)||initialValue<0){toast('初始数值需 ≥ 0','err');return}
  if(isNaN(interestRate)||interestRate<0){toast('利率需 ≥ 0','err');return}
  if(isNaN(debtRate)||debtRate<0){toast('债率需 ≥ 0','err');return}
  if(isNaN(vitalityCost)||vitalityCost<0){toast('活力点花费需 ≥ 0','err');return}

  // 阶段奖励
  let stageRewards=null;
  if(editStage.enabled){
    const hasV=editTypes.indexOf('vitality')>=0;
    const hasP=editTypes.indexOf('progress')>=0;
    const readRow=function(type){
      const arr=[];
      for(let i=0;i<5;i++){
        const el=document.getElementById('stage_'+type+'_'+i);
        let v=el?parseFloat(el.value):NaN;
        if(isNaN(v)||v<0)v=0;
        arr.push(round2(v));
      }
      return arr;
    };
    stageRewards={last:editStage.last!==undefined?editStage.last:0};
    if(hasV)stageRewards.v=readRow('vitality');
    if(hasP)stageRewards.p=readRow('progress');
  }

  const prevTask=id?state.tasks.find(x=>x.id===id):null;
  const wasStaged=prevTask&&taskIsStaged(prevTask);
  const recalc=id?((document.getElementById('taskRecalc').checked)&&!wasStaged&&!editStage.enabled):false;
  saveTaskData({id:id||null,name:name,description:description,scoreTypes:editTypes.slice(),domainIds:domainIds,collectionId:collectionId,initialValue:initialValue,interestRate:interestRate,debtRate:debtRate,vitalityCost:vitalityCost,stageRewards:stageRewards,recalc:recalc});
  closeModal('taskModal');
  toast(id?(recalc?'任务已更新，历史数据已重算':'任务已更新'):'任务已创建');
  render();
}

function openAchModal(id,presetDomId){
  const title=document.getElementById('achModalTitle');
  document.getElementById('achId').value='';
  fillDomainSelect(document.getElementById('achDomain'),presetDomId||'d_default');
  if(id){
    const a=state.achievements.find(x=>x.id===id);
    if(!a)return;
    title.textContent='编辑里程碑';
    document.getElementById('achId').value=id;
    document.getElementById('achName').value=a.name;
    document.getElementById('achThreshold').value=a.threshold;
    document.getElementById('achPoints').value=a.points;
    fillDomainSelect(document.getElementById('achDomain'),a.domainId);
  }else{
    title.textContent='新建里程碑';
    document.getElementById('achName').value='';
    document.getElementById('achThreshold').value=100;
    document.getElementById('achPoints').value=1;
  }
  openModal('achModal');
  setTimeout(()=>document.getElementById('achName').focus(),50);
}

function handleAchSave(){
  const id=document.getElementById('achId').value;
  const name=document.getElementById('achName').value.trim();
  const threshold=parseFloat(document.getElementById('achThreshold').value);
  const points=parseFloat(document.getElementById('achPoints').value);
  const domainId=document.getElementById('achDomain').value;

  if(!name){toast('请输入里程碑名称','err');return}
  if(isNaN(threshold)||threshold<0){toast('门槛需 ≥ 0','err');return}
  if(isNaN(points)||points<=0){toast('成果点需 > 0','err');return}

  saveAchData({id:id||null,name:name,domainId:domainId,threshold:threshold,points:points});
  closeModal('achModal');
  toast(id?'里程碑已更新':'里程碑已设定');
  render();
}

function openProdModal(id,presetCatId){
  const title=document.getElementById('prodModalTitle');
  document.getElementById('prodId').value='';
  fillShopCatSelect(document.getElementById('prodCategory'),presetCatId||'sc_default');
  if(id){
    const p=state.products.find(x=>x.id===id);
    if(!p)return;
    title.textContent='编辑商品';
    document.getElementById('prodId').value=id;
    document.getElementById('prodName').value=p.name;
    document.getElementById('prodDesc').value=p.desc||'';
    document.getElementById('prodPrice').value=p.price;
    document.getElementById('prodStock').value=p.stock;
    document.getElementById('prodDebtRate').value=p.debtRate||0;
    fillShopCatSelect(document.getElementById('prodCategory'),p.categoryId||'sc_default');
    pickCurrency(p.currency);
  }else{
    title.textContent='上架商品';
    document.getElementById('prodName').value='';
    document.getElementById('prodDesc').value='';
    document.getElementById('prodPrice').value=10;
    document.getElementById('prodStock').value=-1;
    document.getElementById('prodDebtRate').value=0;
    pickCurrency('vitality');
  }
  openModal('prodModal');
  setTimeout(()=>document.getElementById('prodName').focus(),50);
}

function pickCurrency(type){
  editCurrency=type;
  document.getElementById('ppV').classList.toggle('sel',type==='vitality');
  document.getElementById('ppA').classList.toggle('sel',type==='achievement');
}

function handleProdSave(){
  const id=document.getElementById('prodId').value;
  const name=document.getElementById('prodName').value.trim();
  const desc=document.getElementById('prodDesc').value.trim();
  const price=parseFloat(document.getElementById('prodPrice').value);
  const stock=parseInt(document.getElementById('prodStock').value,10);
  const debtRate=parseFloat(document.getElementById('prodDebtRate').value);
  const categoryId=document.getElementById('prodCategory').value;

  if(!name){toast('请输入商品名称','err');return}
  if(isNaN(price)||price<0.1){toast('价格需 ≥ 0.1','err');return}
  if(isNaN(stock)||stock<-1){toast('库存需 ≥ -1','err');return}
  if(isNaN(debtRate)||debtRate<0){toast('债率需 ≥ 0','err');return}

  saveProdData({id:id||null,name:name,desc:desc,currency:editCurrency,price:price,stock:stock,debtRate:debtRate,categoryId:categoryId});
  closeModal('prodModal');
  toast(id?'商品已更新':'商品已上架');
  render();
}

function confirmDelTask(id){
  const t=state.tasks.find(x=>x.id===id);
  if(t&&confirm('删除任务「'+t.name+'」？\n（已获得的积分不会消失，可在银行流水撤销此操作）')){delTask(id);toast('任务已删除');render()}
}
function confirmDelAch(id){
  const a=state.achievements.find(x=>x.id===id);
  if(a&&confirm('删除里程碑「'+a.name+'」？\n（已获得的成果点不会消失，可在银行流水撤销此操作）')){delAch(id);toast('里程碑已删除');render()}
}
function confirmDelProd(id){
  const p=state.products.find(x=>x.id===id);
  if(p&&confirm('删除商品「'+p.name+'」？\n（可在银行流水撤销此操作）')){delProd(id);toast('商品已删除');render()}
}

// ===== Toast =====
function toast(msg,type){
  const wrap=document.getElementById('toastWrap');
  const t=document.createElement('div');
  t.className='toast'+(type?' '+type:'');
  t.textContent=msg;
  wrap.appendChild(t);
  setTimeout(()=>t.remove(),2800);
}

// ===== Export / Import =====
function markBackup(){try{localStorage.setItem(BACKUP_KEY,String(Date.now()));}catch(e){}}
function maybeBackupReminder(){
  let last=0;
  try{last=Number(localStorage.getItem(BACKUP_KEY))||0;}catch(e){}
  if(!last)return;
  const days=(Date.now()-last)/864e5;
  if(days>=7){
    toast('已 '+Math.floor(days)+' 天未备份数据，建议「导出」一份备份','warn');
  }
}
function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='计分系统_'+new Date().toISOString().slice(0,10)+'.json';
  a.click();URL.revokeObjectURL(url);
  markBackup();
  toast('数据已导出');
}
function importData(ev){
  const f=ev.target.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=function(e){
    try{
      const d=JSON.parse(e.target.result);
      if(!d.scores)throw 0;
      // Migrate imported tasks to new domainIds format
      const tasks=(d.tasks||[]).map(t=>{
        if(t.domainIds===undefined){
          t.domainIds=t.domainId?[t.domainId]:['d_default'];
          delete t.domainId;
        }
        if(t.description===undefined)t.description='';
        if(t.archived===undefined)t.archived=false;
        return t;
      });
      state={
        scores:d.scores,domains:d.domains||[{id:'d_default',name:'默认'}],
        collections:d.collections||[{id:'c_default',name:'默认'}],
        shopCategories:d.shopCategories||[{id:'sc_default',name:'默认'}],
        collapsedColls:d.collapsedColls||[],
        collapsedAchDoms:d.collapsedAchDoms||[],
        collapsedShopCats:d.collapsedShopCats||[],
        tasks:tasks,achievements:d.achievements||[],
        products:d.products||[],logs:d.logs||[],
        loans:d.loans||[],
        lastDebtDate:d.lastDebtDate||null,
        filterDomain:d.filterDomain||null,
        metrics:Array.isArray(d.metrics)?d.metrics:[],
        cards:Object.assign({exemption:0},d.cards||{}),
        activities:migrateActivities(d)
      };
      save();render();toast('导入成功');
    }catch(err){toast('导入失败：格式不正确','err')}
  };
  r.readAsText(f);ev.target.value='';
}

// ===== PWA Install =====
let deferredPrompt=null;

// Inject manifest via Blob (works for single-file HTML)
function injectManifest(){
  const manifest={
    name:'计分系统',
    short_name:'计分',
    description:'活力点、进度值、成果点自动计分系统',
    start_url:'.',
    display:'standalone',
    background_color:'#e8e8e8',
    theme_color:'#e8e8e8',
    icons:[]
  };
  const blob=new Blob([JSON.stringify(manifest)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  let link=document.querySelector('link[rel="manifest"]');
  if(!link){link=document.createElement('link');link.rel='manifest';document.head.appendChild(link);}
  link.href=url;
}

// Register a minimal service worker via Blob for offline support
function registerSW(){
  if(!('serviceWorker' in navigator))return;
  const swCode=`
    const CACHE='score-sys-v1';
    self.addEventListener('install',e=>{self.skipWaiting()});
    self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});
    self.addEventListener('fetch',e=>{
      e.respondWith(
        caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
          const copy=resp.clone();
          caches.open(CACHE).then(c=>c.put(e.request,copy));
          return resp;
        }).catch(()=>r))
      );
    });
  `;
  const blob=new Blob([swCode],{type:'application/javascript'});
  const url=URL.createObjectURL(blob);
  navigator.serviceWorker.register(url).catch(()=>{});
}

function initPWA(){
  injectManifest();
  registerSW();

  // Detect if already running as installed app
  function isStandalone(){
    return window.matchMedia('(display-mode: standalone)').matches
      ||window.navigator.standalone===true;
  }

  const btn=document.getElementById('installBtn');

  // If already standalone, hide install button
  if(isStandalone()){
    if(btn)btn.style.display='none';
  }

  // Listen for install prompt (capture deferredPrompt, button already visible)
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();
    deferredPrompt=e;
  });

  // Listen for app installed event
  window.addEventListener('appinstalled',()=>{
    if(btn)btn.style.display='none';
    deferredPrompt=null;
    toast('已安装至桌面');
  });

  // Also check display-mode change (uninstall scenario)
  window.matchMedia('(display-mode: standalone)').addEventListener('change',e=>{
    if(!btn)return;
    if(e.matches){
      btn.style.display='none';
    }else{
      // Running in browser after uninstall — show button
      btn.style.display='';
    }
  });
}

function installApp(){
  if(!deferredPrompt){
    // Browser doesn't support install prompt — show manual instructions
    openModal('installModal');
    return;
  }
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(()=>{
    deferredPrompt=null;
    const btn=document.getElementById('installBtn');
    if(btn)btn.style.display='none';
  });
}

// 启动装载：优先 IndexedDB；若无则从 localStorage 迁移后清除旧值
async function loadStateFromStorage(){
  loadIssue=null;
  let raw=null;
  try{raw=await idbGet(KEY);}catch(e){}
  const hasIDB=(raw!==undefined&&raw!==null&&raw!=='');
  if(hasIDB){
    const s=parseState(raw);
    if(loadIssue){
      if(loadIssue.type==='corrupt'){try{await idbPut(KEY+'_corrupt',raw);}catch(e){}}
      // 数据损坏/被截断：先备份原始内容，避免被下一次保存覆盖而彻底丢失
      try{localStorage.setItem('score_sys_corrupt_backup_'+Date.now(),raw);}catch(e){}
    }
    return s;
  }
  let legacy=null;
  try{legacy=localStorage.getItem(KEY);}catch(e){}
  if(legacy){
    const s=parseState(legacy);
    if(loadIssue){
      if(loadIssue.type==='corrupt'){try{await idbPut(KEY+'_corrupt',legacy);}catch(e){}}
      try{localStorage.setItem('score_sys_corrupt_backup_'+Date.now(),legacy);}catch(e){}
    }else{
      try{await idbPut(KEY,legacy);localStorage.removeItem(KEY);}catch(e){}
    }
    return s;
  }
  return defaults();
}

async function attemptRecovery(){
  const bar=document.getElementById('recoverBar');
  const btn=bar?bar.querySelector('button'):null;
  if(btn){btn.disabled=true;btn.textContent='恢复中…';}
  try{
    let raw=null;
    try{raw=await idbGet(KEY+'_corrupt');}catch(e){}
    if(raw===undefined||raw===null||raw===''){toast('未找到可恢复的原始数据','err');return;}
    let s=null;
    try{s=JSON.parse(raw);}catch(e){s=salvageJSON(raw);}
    if(!s||typeof s!=='object'||!s.scores){toast('恢复失败：原始内容无法解析','err');return;}
    state=parseState(JSON.stringify(s));
    save();
    render();
    toast('已尝试恢复上次数据','ok');
  }finally{
    if(bar)bar.style.display='none';
    if(btn){btn.disabled=false;btn.textContent='尝试恢复';}
  }
}

// ===== Init =====
async function init(){
  state=await loadStateFromStorage();
  if(loadIssue){
    toast(loadIssue.type==='salvaged'
      ?'检测到数据不完整，已自动修复并恢复可读部分（原始内容已备份）'
      :'本地数据已损坏，已重置（原始内容已备份）','err');
    if(loadIssue.type==='corrupt'){const rb=document.getElementById('recoverBar');if(rb)rb.style.display='flex';}
  }
  maybeBackupReminder();
  // 申请持久化存储，降低浏览器自动清理 IndexedDB 的风险
  try{
    if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
  }catch(e){}
  const n=new Date(),wd=['日','一','二','三','四','五','六'];
  document.getElementById('todayDate').textContent=
    n.getFullYear()+'.'+String(n.getMonth()+1).padStart(2,'0')+'.'+String(n.getDate()).padStart(2,'0')+' 周'+wd[n.getDay()];

  // Ensure default domain/collection/shopCategory exist
  if(!state.domains.find(d=>d.id==='d_default'))state.domains.unshift({id:'d_default',name:'默认'});
  if(!state.collections.find(c=>c.id==='c_default'))state.collections.unshift({id:'c_default',name:'默认'});
  if(!state.shopCategories.find(c=>c.id==='sc_default'))state.shopCategories.unshift({id:'sc_default',name:'默认'});

  // 能力雷达指标为纯自定义：未创建指标时不显示任何指标
  if(!Array.isArray(state.metrics))state.metrics=[];

  document.querySelectorAll('.modal-bg').forEach(bg=>{
    bg.addEventListener('click',e=>{if(e.target===bg)bg.classList.remove('show')});
  });

  document.getElementById('taskSaveBtn').addEventListener('click',handleTaskSave);
  document.getElementById('achSaveBtn').addEventListener('click',handleAchSave);
  document.getElementById('prodSaveBtn').addEventListener('click',handleProdSave);
  document.getElementById('metricSaveBtn').addEventListener('click',handleMetricSave);
  document.getElementById('activitySaveBtn').addEventListener('click',handleActivitySave);

  ['taskModal','achModal','prodModal','metricModal','activityModal'].forEach(mid=>{
    document.getElementById(mid).addEventListener('keydown',e=>{
      if(e.key==='Enter'&&e.target.tagName==='INPUT'){
        e.preventDefault();
        document.querySelector('#'+mid+' .modal-foot .btn:last-child').click();
      }
    });
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape')document.querySelectorAll('.modal-bg.show').forEach(m=>m.classList.remove('show'));
  });

  checkAchievements();
  processDailyTaskDebts();
  processMetabolism();
  processLoans();
  processActivities();
  setInterval(schedulerTick,60000);
  initDrag();
  initTaskReveal();
  bindTaskSliders();
  initPWA();
  render();
}

init();
