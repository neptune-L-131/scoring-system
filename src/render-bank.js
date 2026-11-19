import { renderAssetDefs } from './asset-ui.js';
import { registerRenderer } from './render.js';
import { eachStatsBucket, weekScore } from './conditions.js';
import { ASSET_LOG_CATS, LOG_DISPLAY } from './constants.js';
import { delDomain, delMetric, openMetricModal, renameDomain } from './library.js';
import { openAchModal } from './modals.js';
import { assetCatName, assetLogMeta, dayKey, esc, escAttr, fmt, fmtTime, now } from './pure.js';
import { achCardHTML, setScoreCell } from './render-work.js';
import { registerPanelTarget } from './render-targets.js';
import { state } from './state.js';
import { accountLabel, shadowLabel } from './stats.js';
import { addDays, dayDiff, dayStart as dayStartOf, weekStart } from './time.js';
import { toggleCollapse } from './ui-events.js';
import { UNDO_ADAPTERS, undoLog } from './undo.js';
import { domainName, domainProgress, metricValue, totalProgress } from './utils.js';
import { logRowView, shadowRowView } from './view-models.js';
import { collBodyHTML, collGroupHTML, collHeaderHTML, dragHandleHTML, logItemHTML } from './view-primitives.js';
// render-bank.js —— 渲染：银行页（图表/雷达）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Render: Bank =====
function renderBank(){
  setScoreCell('bVitality',state.scores.vitality);
  setScoreCell('bProgress',totalProgress());
  setScoreCell('bAchievement',state.scores.achievement);

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
      const days=l.date?Math.max(0,dayDiff(now(),l.date)):0;
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

  // Stats：全部读 ext.stats 生命周期计数器（不再扫 state.logs，日志截断后仍稳定）
  const stat=state.ext.stats;
  const vIn=Number(stat.lifetimeVitalityIn)||0,vOut=-(Number(stat.lifetimeVitalityOut)||0);
  const pIn=Number(stat.lifetimeProgressIn)||0;
  const aIn=Number(stat.lifetimeAchievementIn)||0,aOut=-(Number(stat.lifetimeAchievementOut)||0);
  const totalCI=Number(stat.totalCheckins)||0;
  const unlocked=state.achievements.filter(a=>a.unlocked).length;
  const purchases=Number(stat.totalPurchases)||0;

  const vIncomeEl=document.getElementById('vIncome');
  vIncomeEl.textContent=fmt(vIn);
  vIncomeEl.classList.toggle('neg',vIn<0);
  document.getElementById('vSpend').textContent=fmt(vOut);
  const pIncomeEl=document.getElementById('pIncome');
  pIncomeEl.textContent=fmt(pIn);
  pIncomeEl.classList.toggle('neg',pIn<0);
  document.getElementById('totalCheckins').textContent=totalCI;
  const aIncomeEl=document.getElementById('aIncome');
  aIncomeEl.textContent=fmt(aIn);
  aIncomeEl.classList.toggle('neg',aIn<0);
  document.getElementById('achUnlocked').textContent=unlocked;
  const aSpendEl=document.getElementById('aSpend');
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
      let actions=dragHandleHTML('拖拽领域');
      if(d.id!=='d_default'){
        actions+='<button onclick="renameDomain(\''+d.id+'\')">重命名</button><button onclick="delDomain(\''+d.id+'\')">删除</button>';
      }
      actions+='<button onclick="openAchModal(null,\''+d.id+'\')">+ 里程碑</button>';
      ahtml+=collGroupHTML('ach-dom-group','data-dom-id="'+d.id+'"',isCollapsed,
        (showHeader?collHeaderHTML({onclick:"toggleCollapse('ach-domain','"+d.id+"')",name:esc(d.name),count:achs.length,countLabel:'个里程碑',actions:actions}):'')
        +collBodyHTML(achs.map(a=>achCardHTML(a,d.id)).join('')));
    });
    ag.innerHTML=ahtml;
  }

  drawChart();
  drawVitalityFlowChart();
  drawWeekCompareChart();

  renderBankLogs();
  renderShadowList();
  renderAssetDefs();
}

// ===== 账本视图（只读展示层） =====
// 筛选/展开/折叠都是界面状态：只活在这个模块里，不写 state、不进存档，
// 也不改变任何记账语义（撤销仍走原来的 undoLog，单条流水不变）。
const LEDGER_SRC_GROUPS=[
  {key:'checkin',name:'打卡'},
  {key:'purchase',name:'购买'},
  {key:'task',name:'任务'},
  {key:'affair',name:'事项'},
  {key:'chore',name:'杂事'},
  {key:'budget',name:'预算'},
  {key:'flow',name:'动作流'},
  {key:'achievement',name:'里程碑'},
  {key:'asset',name:'资产'},
  {key:'system',name:'系统'},
];
const LEDGER_RANGES=[
  {v:'today',n:'今天'},
  {v:'7d',n:'最近7天'},
  {v:'30d',n:'最近30天'},
];
const ledgerState={acct:'all',src:'all',cat:'all',range:'all',link:'all',withShadow:false,days:{},detail:''};

// 来源类型：按前缀归组，未知来源落到「系统」，不隐藏任何一条记录
function ledgerSrcGroup(l){
  let s=String((l&&l.src)||'');
  if(s.indexOf('undo-')===0)s=s.slice(5);
  if(!s)return{key:'system',name:'系统'};
  if(s.indexOf('checkin')===0)return{key:'checkin',name:'打卡'};
  if(s.indexOf('purchase')===0)return{key:'purchase',name:'购买'};
  if(s==='cost')return{key:'task',name:'任务'};
  if(s.indexOf('affair')===0)return{key:'affair',name:'事项'};
  if(s.indexOf('chore')===0)return{key:'chore',name:'杂事'};
  if(s.indexOf('budget')===0)return{key:'budget',name:'预算'};
  if(s.indexOf('flow')===0)return{key:'flow',name:'动作流'};
  if(s.indexOf('achievement')===0)return{key:'achievement',name:'里程碑'};
  if(s.indexOf('card')===0||s.indexOf('asset')===0||s==='exempt-use')return{key:'asset',name:'资产'};
  return{key:'system',name:'系统'};
}
// 进度类流水可能一笔跨多个领域：拆分优先，缺失时退回 dom，再缺则归默认领域
function ledgerProgressAccounts(l){
  const doms=[];
  if(Array.isArray(l.splits)){
    l.splits.forEach(function(sp){if(sp&&sp.dom&&doms.indexOf(sp.dom)<0)doms.push(sp.dom);});
  }
  String(l.dom||'').split(',').forEach(function(d){if(d&&doms.indexOf(d)<0)doms.push(d);});
  if(!doms.length)doms.push('d_default');
  return doms.map(function(d){return 'progress:'+d;});
}
// 一条流水涉及的账户键：用于「按账户/资产」筛选
function ledgerLogAccounts(l){
  const out=[];
  const add=function(k){if(k&&out.indexOf(k)<0)out.push(k);};
  const st=l&&l.st;
  if(st==='both'){
    add('vitality');
    ledgerProgressAccounts(l).forEach(add);
  }else if(st==='vitality'||st==='achievement'){
    add(st);
  }else if(st==='progress'){
    ledgerProgressAccounts(l).forEach(add);
  }else if(st==='card'){
    add('card:'+String(l.card||''));
  }else if(typeof st==='string'&&st){
    add('st:'+st);
  }
  if(!out.length)add('none');
  return out;
}
function ledgerAssetName(id){
  if(!id)return'未知';
  const d=(state.assetDefs||[]).find(function(x){return x&&x.id===id;});
  if(d&&d.name)return d.name;
  return String(id);
}
function ledgerAccountLabel(key){
  if(key==='vitality')return'活力点';
  if(key==='achievement')return'成果点';
  if(key==='none')return'无金额事件';
  if(key==='unknown')return'未知';
  if(key.indexOf('progress:')===0)return'进度·'+domainName(key.slice(9));
  if(key.indexOf('card:')===0)return'资产·'+ledgerAssetName(key.slice(5));
  if(key.indexOf('st:')===0)return'其他账户';
  return key||'未知';
}
function ledgerAcctSort(key){
  if(key==='vitality')return 0;
  if(key==='achievement')return 1;
  if(key.indexOf('progress:')===0)return 2;
  if(key.indexOf('card:')===0)return 3;
  if(key==='none')return 4;
  return 5;
}
function ledgerShadowAccount(r){
  const a=String((r&&r.acct)||'');
  return a||'unknown';
}
function ledgerTaskName(id){const t=(state.tasks||[]).find(function(x){return x&&x.id===id;});return t&&t.name?t.name:'未知';}
function ledgerAffairName(id){const a=(state.affairs||[]).find(function(x){return x&&x.id===id;});return a&&a.name?a.name:'未知';}
function ledgerChoreName(id){const c=(state.chores||[]).find(function(x){return x&&x.id===id;});return c&&c.name?c.name:'未知';}
function ledgerFlowName(id){const f=(state.flows||[]).find(function(x){return x&&x.id===id;});return f&&f.name?f.name:'未知动作流';}
function ledgerRunOf(id){
  const runs=state.ext&&state.ext.flowRuns;
  return (runs&&runs.byId&&runs.byId[id])||null;
}
// 归一化会把购买执行退化成周期执行且丢掉 orderId：这里用流水反查，保证因果链跨刷新仍成立
function ledgerRunOrderId(id){
  const run=ledgerRunOf(id);
  if(run&&run.orderId)return String(run.orderId);
  const l=(state.logs||[]).find(function(x){return x&&x.execRunId===id&&x.orderId;});
  return l?String(l.orderId):'';
}
function ledgerRunLabel(id){
  const run=ledgerRunOf(id);
  const name=(run&&run.flowName)||ledgerFlowName(run&&run.flowId);
  return name||'未知动作流';
}
function ledgerRunTime(id){
  const run=ledgerRunOf(id);
  if(run&&run.startedAt)return run.startedAt;
  const l=(state.logs||[]).find(function(x){return x&&(x.flowRunId===id||x.execRunId===id);});
  return (l&&l.time)||0;
}
function ledgerRunTriggerLabel(run,runId){
  const t=run&&run.trigger;
  if(t==='manual')return'手动执行';
  if(t==='event')return'事件触发';
  if(t==='purchase'||ledgerRunOrderId(runId))return'购买执行';
  return'周期执行';
}
function ledgerRunChildIds(run,l){
  const out=[];
  const add=function(arr){
    if(!Array.isArray(arr))return;
    arr.forEach(function(x){
      x=String(x||'');
      if(x&&out.indexOf(x)<0)out.push(x);
    });
  };
  add(run&&run.childLogIds);
  add(run&&run.journal&&run.journal.logIds);
  add(l&&l.childLogIds);
  return out;
}
// 事项级关联：任务 / 项目 / 杂事（只看某条关联记录）
function ledgerLogLinks(l){
  const out=[];
  if(l.taskId)out.push({key:'task:'+l.taskId,kind:'task',id:String(l.taskId),kindLabel:'任务',name:ledgerTaskName(l.taskId)});
  if(l.affairId)out.push({key:'affair:'+l.affairId,kind:'affair',id:String(l.affairId),kindLabel:'项目',name:ledgerAffairName(l.affairId)});
  if(l.choreId)out.push({key:'chore:'+l.choreId,kind:'chore',id:String(l.choreId),kindLabel:'杂事',name:ledgerChoreName(l.choreId)});
  return out;
}
function ledgerInRange(t,range){
  if(!range||range==='all')return true;
  const ts=Number(t)||0;
  const start=dayStartOf(now());
  if(range==='today')return ts>=start;
  if(range==='7d')return ts>=addDays(start,-6);
  if(range==='30d')return ts>=addDays(start,-29);
  return true;
}
// 动作流筛选：执行产生的流水、执行事件本身、journal 流水、同一订单流水都算“相关”
function ledgerMatchesLink(l,value){
  const raw=String(value||'');
  if(raw.indexOf('run:')===0){
    const id=raw.slice(4);
    if(!id)return false;
    if(l.flowRunId===id||l.execRunId===id)return true;
    const run=ledgerRunOf(id);
    if(run){
      if(run.journalLogId===l.id)return true;
      if(Array.isArray(run.childLogIds)&&run.childLogIds.indexOf(l.id)>=0)return true;
    }
    const oid=ledgerRunOrderId(id);
    return !!(oid&&l.orderId===oid);
  }
  if(raw.indexOf('task:')===0)return l.taskId===raw.slice(5);
  if(raw.indexOf('affair:')===0)return l.affairId===raw.slice(7);
  if(raw.indexOf('chore:')===0)return l.choreId===raw.slice(6);
  return false;
}
function ledgerLogMatch(l){
  if(ledgerState.acct!=='all'&&ledgerLogAccounts(l).indexOf(ledgerState.acct)<0)return false;
  if(ledgerState.src!=='all'&&ledgerSrcGroup(l).key!==ledgerState.src)return false;
  if(ledgerState.cat!=='all'&&(l.assetCat||'')!==ledgerState.cat)return false;
  if(!ledgerInRange(l.time,ledgerState.range))return false;
  if(ledgerState.link!=='all'&&!ledgerMatchesLink(l,ledgerState.link))return false;
  return true;
}
function ledgerShadowMatch(r){
  if(ledgerState.acct!=='all'&&ledgerShadowAccount(r)!==ledgerState.acct)return false;
  if(ledgerState.src!=='all'&&ledgerSrcGroup({src:r&&r.src}).key!==ledgerState.src)return false;
  if(ledgerState.cat!=='all'&&((r&&r.assetCat)||'')!==ledgerState.cat)return false;
  if(!ledgerInRange(r&&r.ts,ledgerState.range))return false;
  if(ledgerState.link!=='all')return false;
  return true;
}
function ledgerVisibleRows(){
  const rows=(state.logs||[]).map(function(l){return{log:l,shadow:false,time:Number(l.time)||0};});
  if(ledgerState.withShadow&&state.ext&&Array.isArray(state.ext.shadow)){
    state.ext.shadow.forEach(function(r){rows.push({log:r,shadow:true,time:Number(r&&r.ts)||0});});
  }
  const out=rows.filter(function(row){
    return row.shadow?ledgerShadowMatch(row.log):ledgerLogMatch(row.log);
  });
  out.sort(function(a,b){return b.time-a.time;});
  return out;
}
function ledgerFilterActive(){
  return ledgerState.acct!=='all'||ledgerState.src!=='all'||ledgerState.cat!=='all'
    ||ledgerState.range!=='all'||ledgerState.link!=='all'||ledgerState.withShadow;
}
function ledgerOptions(){
  const logs=state.logs||[];
  const acc={},src={},cat={},links={};
  const addLink=function(x){
    if(!links[x.key])links[x.key]={key:x.key,kind:x.kind,id:x.id,kindLabel:x.kindLabel,name:x.name,time:x.time||0,count:0};
    links[x.key].count++;
  };
  // 购买单里只有主腿带 execRunId：用订单反查，让发放腿也计入同一次执行的「相关记录」
  const orderRun={};
  logs.forEach(function(l){
    if(l.execRunId&&l.orderId)orderRun[l.orderId]=l.execRunId;
  });
  logs.forEach(function(l){
    ledgerLogAccounts(l).forEach(function(k){acc[k]=(acc[k]||0)+1;});
    src[ledgerSrcGroup(l).key]=(src[ledgerSrcGroup(l).key]||0)+1;
    if(l.assetCat)cat[l.assetCat]=(cat[l.assetCat]||0)+1;
    ledgerLogLinks(l).forEach(addLink);
    const rid=l.flowRunId||l.execRunId||orderRun[l.orderId]||'';
    if(rid)addLink({key:'run:'+rid,kind:'run',id:String(rid),kindLabel:'动作流',name:ledgerRunLabel(rid),time:ledgerRunTime(rid)});
  });
  const shadow=(ledgerState.withShadow&&state.ext&&Array.isArray(state.ext.shadow))?state.ext.shadow:[];
  shadow.forEach(function(r){
    const k=ledgerShadowAccount(r);acc[k]=(acc[k]||0)+1;
    const g=ledgerSrcGroup({src:r&&r.src});src[g.key]=(src[g.key]||0)+1;
    if(r&&r.assetCat)cat[r.assetCat]=(cat[r.assetCat]||0)+1;
  });
  const accounts=Object.keys(acc).map(function(k){return{v:k,n:ledgerAccountLabel(k)+' ('+acc[k]+')'};});
  accounts.sort(function(a,b){return ledgerAcctSort(a.v)-ledgerAcctSort(b.v);});
  const srcs=LEDGER_SRC_GROUPS.filter(function(g){return src[g.key];}).map(function(g){
    return{v:g.key,n:g.name+' ('+src[g.key]+')'};
  });
  const cats=ASSET_LOG_CATS.filter(function(c){return cat[c];}).map(function(c){
    return{v:c,n:assetCatName(c)+' ('+cat[c]+')'};
  });
  const kindOrder={task:0,affair:1,chore:2,run:3};
  const linkList=Object.keys(links).map(function(k){return links[k];});
  linkList.sort(function(a,b){
    const ka=kindOrder[a.kind]===undefined?9:kindOrder[a.kind];
    const kb=kindOrder[b.kind]===undefined?9:kindOrder[b.kind];
    const d=ka-kb;
    return d!==0?d:(b.time||0)-(a.time||0);
  });
  const linkOpts=linkList.map(function(x){
    const label=x.kind==='run'
      ?'动作流·'+x.name+'（'+fmtTime(x.time)+'）'
      :x.kindLabel+'·'+x.name;
    return{v:x.key,n:label+' ('+x.count+')'};
  });
  return{accounts:accounts,srcs:srcs,cats:cats,links:linkOpts};
}
function ledgerSelectHTML(key,allLabel,opts,cur){
  let h='<select class="ledger-sel" onchange="setLedgerFilter(\''+key+'\',this.value)">';
  h+='<option value="all"'+(cur==='all'?' selected':'')+'>'+esc(allLabel)+'</option>';
  opts.forEach(function(o){
    h+='<option value="'+escAttr(o.v)+'"'+(o.v===cur?' selected':'')+'>'+esc(o.n)+'</option>';
  });
  return h+'</select>';
}
function renderLedgerBar(){
  const bar=document.getElementById('ledgerBar');
  if(!bar)return;
  if(!(state.logs||[]).length){
    bar.innerHTML='';
    return;
  }
  const o=ledgerOptions();
  // 选中的值可能因数据变化消失：回落到“全部”，避免列表空白且无从恢复
  const hasOpt=function(list,v){return list.some(function(x){return x.v===v;});};
  if(ledgerState.acct!=='all'&&!hasOpt(o.accounts,ledgerState.acct))ledgerState.acct='all';
  if(ledgerState.src!=='all'&&!hasOpt(o.srcs,ledgerState.src))ledgerState.src='all';
  if(ledgerState.cat!=='all'&&!hasOpt(o.cats,ledgerState.cat))ledgerState.cat='all';
  if(ledgerState.link!=='all'&&!hasOpt(o.links,ledgerState.link))ledgerState.link='all';
  let html='<div class="ledger-bar">';
  html+=ledgerSelectHTML('acct','全部账户/资产',o.accounts,ledgerState.acct);
  html+=ledgerSelectHTML('src','全部来源',o.srcs,ledgerState.src);
  if(o.cats.length)html+=ledgerSelectHTML('cat','全部资产动作',o.cats,ledgerState.cat);
  html+=ledgerSelectHTML('range','全部时间',LEDGER_RANGES,ledgerState.range);
  html+=ledgerSelectHTML('link','全部关联',o.links,ledgerState.link);
  html+='<label class="ledger-check"><input type="checkbox"'+(ledgerState.withShadow?' checked':'')
    +' onchange="toggleLedgerShadowFilter(this.checked)"> 含隐形调整</label>';
  if(ledgerFilterActive())html+='<button class="ledger-clear" onclick="clearLedgerFilter()">清除筛选</button>';
  html+='</div>';
  bar.innerHTML=html;
}
function ledgerHasDetail(l){
  if(!l)return false;
  return !!(l.taskId||l.affairId||l.choreId||l.flowRunId||l.execRunId||l.orderId||l.prodId||l.st==='card'||l.assetCat);
}
function ledgerDetailHTML(l){
  let h='<div class="log-detail">';
  const line=function(k,v){
    h+='<div class="ld-line"><span class="ld-k">'+esc(k)+'</span><span class="ld-v">'+v+'</span></div>';
  };
  line('账户',esc(ledgerLogAccounts(l).map(ledgerAccountLabel).join('、')));
  line('来源',esc(ledgerSrcGroup(l).name));
  if(l.st==='card'||l.assetCat){
    const m=assetLogMeta(l);
    line('资产动作',esc(m.catName));
    line('资产去向',esc(m.from)+' → '+esc(m.to));
  }
  if(l.prodId){
    const p=(state.products||[]).find(function(x){return x&&x.id===l.prodId;});
    line('商品',esc(p&&p.name?p.name:'未知'));
  }
  if(l.orderId)line('订单',esc(String(l.orderId)));
  const links=ledgerLogLinks(l);
  if(links.length){
    h+='<div class="ld-sec">关联事项</div>';
    links.forEach(function(x){
      h+='<div class="ld-line"><span class="ld-k">'+esc(x.kindLabel)+'</span><span class="ld-v">'+esc(x.name)
        +' <button class="ledger-link" onclick="focusLedgerLink(\''+escAttr(x.kind)+'\',\''+escAttr(x.id)+'\')">只看相关</button></span></div>';
    });
  }
  if(l.orderId){
    const sibs=(state.logs||[]).filter(function(x){return x&&x.orderId===l.orderId;});
    if(sibs.length>1){
      h+='<div class="ld-sec">本单流水 · '+sibs.length+' 笔</div><div class="ld-list">';
      sibs.forEach(function(x){
        const cv=logRowView(x,[]);
        h+='<div class="ld-chg"><span class="ld-chg-t">'+esc(fmtTime(x.time))+'</span>'
          +'<span class="ld-chg-d">'+esc(x.desc||'未知')+'</span>'
          +'<span class="ld-chg-a '+cv.amtCls+'">'+cv.amount+'</span></div>';
      });
      h+='</div>';
    }
  }
  const rid=l.flowRunId||l.execRunId||'';
  if(rid){
    if(l.src==='flow-run'&&l.flowRunId){
      h+=ledgerRunBlockHTML(rid,l);
    }else{
      h+='<div class="ld-sec">执行</div><div class="ld-line"><span class="ld-k">动作流</span><span class="ld-v">'
        +esc(ledgerRunLabel(rid))+' · '+esc(ledgerRunTriggerLabel(ledgerRunOf(rid),rid))
        +' <button class="ledger-link" onclick="focusLedgerLink(\'run\',\''+escAttr(rid)+'\')">只看这次执行</button></span></div>';
    }
  }
  h+='</div>';
  return h;
}
function ledgerRunBlockHTML(runId,l){
  const run=ledgerRunOf(runId);
  const orderId=ledgerRunOrderId(runId);
  let h='<div class="ld-sec">本次执行 · '+esc(ledgerRunLabel(runId))
    +' <span class="ld-sub">'+esc(ledgerRunTriggerLabel(run,runId))+' · '+esc(fmtTime(ledgerRunTime(runId)))+'</span>'
    +' <button class="ledger-link" onclick="focusLedgerLink(\'run\',\''+escAttr(runId)+'\')">只看这次执行</button></div>';
  if(orderId)h+='<div class="ld-line"><span class="ld-k">来源订单</span><span class="ld-v">'+esc(orderId)+'</span></div>';
  const ids=ledgerRunChildIds(run,l);
  h+='<div class="ld-sec">产生的变动 · '+ids.length+' 笔</div><div class="ld-list">';
  if(!ids.length)h+='<div class="ld-chg"><span class="ld-chg-d">没有独立的变动流水</span><span class="ld-chg-a">—</span></div>';
  ids.forEach(function(id){
    const c=(state.logs||[]).find(function(x){return x&&x.id===id;});
    if(!c){
      h+='<div class="ld-chg"><span class="ld-chg-d">该笔记录已裁剪或不存在</span><span class="ld-chg-a">—</span></div>';
      return;
    }
    const cv=logRowView(c,[]);
    h+='<div class="ld-chg"><span class="ld-chg-t">'+esc(fmtTime(c.time))+'</span>'
      +'<span class="ld-chg-d">'+esc(c.desc||'未知')+'</span>'
      +'<span class="ld-chg-a '+cv.amtCls+'">'+cv.amount+'</span></div>';
  });
  h+='</div>';
  const accounts=(run&&run.journal&&Array.isArray(run.journal.accounts))?run.journal.accounts.filter(function(a){
    return a&&Number(a.delta)!==0;
  }):[];
  if(accounts.length){
    h+='<div class="ld-sec">账户变化</div><div class="ld-list">';
    accounts.forEach(function(a){
      const d=Number(a.delta)||0;
      h+='<div class="ld-chg"><span class="ld-chg-d">'+esc(ledgerAccountLabel(String(a.key||'')))+'</span>'
        +'<span class="ld-chg-a'+(d>0?' pos':' neg')+'">'+esc(fmt(a.before)+' → '+fmt(a.after))+'</span></div>';
    });
    h+='</div>';
  }
  const assets=(run&&run.journal&&Array.isArray(run.journal.assets))?run.journal.assets.filter(function(a){
    return a&&Number(a.delta)!==0;
  }):[];
  if(assets.length){
    h+='<div class="ld-sec">资产变化</div><div class="ld-list">';
    assets.forEach(function(a){
      const d=Number(a.delta)||0;
      h+='<div class="ld-chg"><span class="ld-chg-d">资产·'+esc(ledgerAssetName(String(a.assetId||'')))+'</span>'
        +'<span class="ld-chg-a'+(d>0?' pos':' neg')+'">'+esc(fmt(a.before)+' → '+fmt(a.after))+'</span></div>';
    });
    h+='</div>';
  }
  if(!run)h+='<div class="ld-note">运行记录已裁剪：只能看到流水与执行标识，无法还原账户前后值。</div>';
  return h;
}
function ledgerRowHTML(row,undoableSrc){
  if(row.shadow)return ledgerShadowRowHTML(row.log);
  const l=row.log;
  const v=logRowView(l,undoableSrc);
  const amt=Number(l.amt)||0;
  const dir=amt>0?'in':amt<0?'out':'flat';
  const open=ledgerState.detail===String(l.id);
  let action=v.canUndo?'<button class="log-undo" onclick="undoLog(\''+v.id+'\')">撤销</button>':'';
  if(ledgerHasDetail(l)){
    action+='<button class="log-more'+(open?' on':'')+'" onclick="toggleLedgerDetail(\''+v.id+'\')">'+(open?'收起':'因果')+'</button>';
  }
  return '<div class="ledger-row '+dir+(l.st==='card'?' asset':'')+(open?' open':'')+'">'
    +logItemHTML({
      dot:v.dot,
      desc:'<span class="log-src">'+esc(ledgerSrcGroup(l).name)+'</span>'+esc(l.desc?String(l.desc):'未知'),
      amt:v.amount,amtCls:v.amtCls,time:fmtTime(v.time),action:action,
    })
    +(open?ledgerDetailHTML(l):'')
    +'</div>';
}
function ledgerShadowRowHTML(r){
  const src=r||{};
  const v=shadowRowView({acct:String(src.acct||''),delta:Number(src.delta)||0,before:src.before,after:src.after,ts:src.ts});
  const label=shadowLabel(String(src.src||''),src.label?String(src.label):'');
  const acct=ledgerAccountLabel(ledgerShadowAccount(src));
  const card=String(src.acct||'').indexOf('card:')===0;
  return '<div class="ledger-row shadow'+(card?' asset':'')+'">'
    +logItemHTML({
      dot:'s',
      desc:'<span class="log-src">隐形</span>'+esc(label)+'<span class="log-sub"> · '+esc(acct)+v.range+'</span>',
      amt:v.amount,amtCls:v.amtCls,time:fmtTime(v.time),
    })
    +'</div>';
}
function ledgerDayLabel(ts){
  const today=dayStartOf(now());
  const t=dayStartOf(ts||0);
  if(t===today)return'今天';
  if(t===addDays(today,-1))return'昨天';
  const d=new Date(ts);
  return (d.getMonth()+1)+'月'+d.getDate()+'日';
}
function ledgerGroups(rows){
  const groups=[],idx={};
  rows.forEach(function(row){
    const key=dayKey(row.time||0);
    if(!idx[key]){idx[key]={key:key,time:row.time||0,rows:[]};groups.push(idx[key]);}
    idx[key].rows.push(row);
  });
  return groups;
}
// 默认只展开最近一天，其余按天折叠：手机上一屏约 8-12 行，不会一次铺满几百条
function ledgerDayOpen(key,index){
  if(Object.prototype.hasOwnProperty.call(ledgerState.days,key))return !!ledgerState.days[key];
  return index===0;
}
function ledgerDayHeadHTML(group,open){
  return '<div class="ledger-day-head" onclick="toggleLedgerDay(\''+escAttr(group.key)+'\')">'
    +'<span class="coll-toggle">▼</span>'
    +'<span class="ld-day">'+esc(ledgerDayLabel(group.time))+'</span>'
    +'<span class="ld-day-meta">'+esc(group.key)+' · '+group.rows.length+' 笔</span>'
    +'</div>';
}
// ===== 事件派发失败提示（只读展示 ext.events 的结果，不写任何数据） =====
// 事件在提交后派发失败时，结果只落在 event-bus 的 ext.events[].results 与一条流水里。
// 这里把结果翻译成中文提示放到流水面板顶部；没有失败时返回空串，不制造噪声。
const EVENT_FAIL_TEXT={
  EVENT_BAD:'事件数据不合法，已忽略派发',
  EVENT_DEPTH_LIMIT:'事件链深度超过上限，拒绝派发',
  EVENT_OVERFLOW:'单次事件触发的动作流超出上限，部分未执行',
  EVENT_REENTRANT:'事件派发过程中产生的新事件不会递归执行',
  FLOW_COMPILE_FAILED:'动作流无法编译',
  FLOW_EVENT_EXCEPTION:'动作流执行时抛出异常',
  FLOW_EVENT_FAILED:'动作流执行失败',
};
function ledgerEventFailKind(kind){
  return kind==='purchase'?'购买':'打卡';
}
function ledgerEventFailReason(r){
  const msg=String((r&&r.message)||'').trim();
  if(msg)return msg;
  const code=String((r&&r.code)||'');
  return EVENT_FAIL_TEXT[code]||('动作流执行失败'+(code?'（'+code+'）':''));
}
// 读取已有结果：只挑真正的失败（幂等跳过不算失败），新的在前
function ledgerEventFails(){
  const store=state.ext&&state.ext.events;
  const recent=(store&&Array.isArray(store.recent))?store.recent:[];
  const out=[];
  recent.forEach(function(ev){
    const results=(ev&&Array.isArray(ev.results))?ev.results:[];
    results.forEach(function(r){
      if(!r||r.ok!==false)return;
      if(r.skipped==='already-run'||r.code==='EVENT_ALREADY_RUN')return;
      out.push({
        time:Number(ev.occurredAt)||0,
        kind:ev.kind,
        flowId:String(r.flowId||''),
        reason:ledgerEventFailReason(r),
      });
    });
  });
  return out;
}
function ledgerEventFailHTML(){
  const fails=ledgerEventFails();
  if(!fails.length)return '';
  const max=5;
  let h='<div class="ledger-event-fail"><div class="ledger-event-fail-head">最近事件派发失败 '+fails.length+' 条</div>';
  fails.slice(0,max).forEach(function(f){
    const who=f.flowId?'动作流「'+ledgerFlowName(f.flowId)+'」':'事件派发';
    h+='<div class="ledger-event-fail-row"><span class="lef-t">'+esc(fmtTime(f.time))+'</span>'
      +'<span class="lef-k">'+esc(ledgerEventFailKind(f.kind))+'</span>'
      +'<span class="lef-f">'+esc(who)+'</span>'
      +'<span class="lef-r">'+esc(f.reason)+'</span></div>';
  });
  if(fails.length>max)h+='<div class="ledger-event-fail-more">另有 '+(fails.length-max)+' 条更早的失败未展开</div>';
  h+='</div>';
  return h;
}
// 流水面板：最近记录行（bank.logs 的独立入口）
function renderBankLogs(){
  const all=state.logs||[];
  const rows=ledgerVisibleRows();
  const meta=document.getElementById('logMeta');
  if(meta){
    let txt=all.length+' 条';
    if(ledgerFilterActive())txt+=' · 命中 '+rows.length+' 条';
    if(rows.length>LOG_DISPLAY)txt+='（仅显示最近 '+LOG_DISPLAY+' 条）';
    meta.textContent=txt;
  }
  renderLedgerBar();
  const ll=document.getElementById('logList');
  if(!ll)return;
  const failHTML=ledgerEventFailHTML();
  if(!all.length){
    ll.innerHTML=failHTML+'<div class="empty" style="padding:24px"><p style="margin:0">暂无记录</p></div>';
    return;
  }
  const shown=rows.slice(0,LOG_DISPLAY);
  if(!shown.length){
    ll.innerHTML=failHTML+'<div class="empty" style="padding:24px"><p style="margin:0">当前筛选没有匹配的记录</p>'
      +'<button class="btn btn-sm" onclick="clearLedgerFilter()">清除筛选</button></div>';
    return;
  }
  // 可撤销白名单直接来自适配器注册表：新增一种可撤销类型只需在 UNDO_ADAPTERS 加 key
  const undoableSrc=Object.keys(UNDO_ADAPTERS);
  ll.innerHTML=failHTML+ledgerGroups(shown).map(function(group,gi){
    const open=ledgerDayOpen(group.key,gi);
    return '<div class="coll-group ledger-day'+(open?'':' collapsed')+'">'
      +ledgerDayHeadHTML(group,open)
      +collBodyHTML(group.rows.map(function(row){return ledgerRowHTML(row,undoableSrc);}).join(''))
      +'</div>';
  }).join('');
}
// ===== 账本视图交互（来自筛选栏与行内按钮） =====
function setLedgerFilter(key,value){
  if(!Object.prototype.hasOwnProperty.call(ledgerState,key))return;
  ledgerState[key]=String(value||'all')||'all';
  renderBankLogs();
}
function clearLedgerFilter(){
  ledgerState.acct='all';
  ledgerState.src='all';
  ledgerState.cat='all';
  ledgerState.range='all';
  ledgerState.link='all';
  ledgerState.withShadow=false;
  renderBankLogs();
}
function toggleLedgerShadowFilter(on){
  ledgerState.withShadow=!!on;
  renderBankLogs();
}
function toggleLedgerDay(key){
  key=String(key||'');
  if(!key)return;
  const groups=ledgerGroups(ledgerVisibleRows().slice(0,LOG_DISPLAY));
  let cur=false;
  for(let i=0;i<groups.length;i++){
    if(groups[i].key===key){cur=ledgerDayOpen(key,i);break;}
  }
  ledgerState.days[key]=!cur;
  renderBankLogs();
}
function toggleLedgerDetail(id){
  id=String(id||'');
  ledgerState.detail=(ledgerState.detail===id)?'':id;
  renderBankLogs();
}
// 从任意记录跳到“只看这次执行 / 只看这个事项”：时间范围同时放宽到全部
function focusLedgerLink(kind,id){
  ledgerState.link=String(kind||'')+':'+String(id||'');
  ledgerState.range='all';
  ledgerState.detail='';
  renderBankLogs();
}
// 余额调整记录：visible:false 的账户增减在这里留痕（贷款放款、撤销、活动回收、删除搬运、重算等）
function toggleShadowList(){
  const el=document.getElementById('shadowList');
  if(!el)return;
  el.style.display=el.style.display==='none'?'block':'none';
}
function renderShadowList(){
  const el=document.getElementById('shadowList');
  const meta=document.getElementById('shadowMeta');
  if(!el)return;
  const list=(state.ext&&Array.isArray(state.ext.shadow))?state.ext.shadow:[];
  if(meta)meta.textContent=list.length?(list.length+' 条'):'暂无';
  if(!list.length){
    el.innerHTML='<div class="empty" style="padding:16px"><p style="margin:0">暂无余额调整（贷款、撤销、活动回收等会记录在这里）</p></div>';
    return;
  }
  el.innerHTML=list.map(function(r){
    const v=shadowRowView(r);
    return logItemHTML({dot:v.dot,
      desc:esc(r.label||shadowLabel(r.src,''))+'<span style="color:var(--text-3);font-size:11px"> · '+esc(accountLabel(r.acct||''))+v.range+'</span>',
      amt:v.amount,amtCls:v.amtCls,time:fmtTime(v.time)});
  }).join('');
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
  const todayTs=dayStartOf(now());
  const dayLabels=[],dayStart=[],dayEnd=[];
  for(let i=days-1;i>=0;i--){
    const ts=addDays(todayTs,-i);
    const d=new Date(ts);
    dayLabels.push((d.getMonth()+1)+'/'+d.getDate());
    dayStart.push(ts);
    dayEnd.push(addDays(ts,1));
  }
  const types=['vitality','progress','achievement'];
  const typeNames={vitality:'活力',progress:'进度',achievement:'成果'};
  // 取色直接读主题 CSS 变量，避免深/浅色再硬编码一份
  const rootStyle=getComputedStyle(document.documentElement);
  function cssVar(name,fallback){const v=(rootStyle.getPropertyValue(name)||'').trim();return v||fallback;}
  const colors={
    vitality:cssVar('--vitality','#5b9a6e'),
    progress:cssVar('--progress','#5b7fa8'),
    achievement:cssVar('--achievement','#b08640')
  };
  const gridColor=cssVar('--border','#e0e0e0');
  const labelColor=cssVar('--text-3','#aaa');
  const zeroColor=cssVar('--border-2','#ccc');
  // 统计日桶一次遍历（每类每天净额）；累计模式再做前缀和，不再扫描 state.logs
  const windowStart=dayStart[0];
  const windowEnd=dayEnd[days-1];
  const before={};
  const daily={};
  types.forEach(type=>{before[type]=0;daily[type]=new Array(days).fill(0);});
  const dayIndex={};
  dayStart.forEach(function(ts,i){dayIndex[dayKey(ts)]=i;});
  const typeKey={vitality:'v',progress:'p',achievement:'a'};
  const st=state.ext&&state.ext.stats;
  if(st&&st.daily){
    const startKey=dayKey(windowStart);
    Object.keys(st.daily).forEach(function(k){
      const b=st.daily[k];
      if(!b)return;
      if(k<startKey){
        types.forEach(type=>{before[type]+=Number(b[typeKey[type]])||0;});
        return;
      }
      const i=dayIndex[k];
      if(i===undefined)return;
      types.forEach(type=>{daily[type][i]+=Number(b[typeKey[type]])||0;});
    });
  }
  const series={};
  types.forEach(type=>{
    series[type]=[];
    let run=before[type];
    for(let i=0;i<days;i++){
      if(chartState.trendMode==='cumulative'){
        run+=daily[type][i];
        series[type].push(run);
      }else{
        series[type].push(daily[type][i]);
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
  // 基线：任一可见序列出现负值（负债）时，0 线居中、上下对称展开；
  // daily 与 cumulative 都适用，避免累计模式下负值折线跑到图表下方
  const hasNeg=types.some(t=>!chartState.hiddenSeries[t]&&series[t].some(v=>v<0));
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
    // 有负值时纵轴从 +maxVal 到 -maxVal，0 刻度正好落在居中基线上
    const val=hasNeg?Math.round(maxVal-(maxVal/2)*g):Math.round(maxVal-(maxVal/4)*g);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+val+'</text>';
  }
  // 0 线（daily / cumulative 有负值时均绘制）
  if(hasNeg){
    s+='<line x1="'+padL+'" y1="'+baseline+'" x2="'+(W-padR)+'" y2="'+baseline+'" stroke="'+zeroColor+'" stroke-width="1.5"/>';
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
  const todayTs=dayStartOf(now());
  // Calculate week boundaries
  const weekRanges=[];
  for(let i=0;i<weeks;i++){
    const end=i===0?addDays(todayTs,1):weekRanges[i-1].start;
    const start=addDays(end,-7);
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
    eachStatsBucket(wr.start,wr.end,function(b){
      prod+=Number(b.prod)||0;
      inv+=Number(b.inv)||0;
      cons+=Number(b.cons)||0;
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
  const todayTs=dayStartOf(now());
  const ranges=[];
  for(let i=weeks-1;i>=0;i--){
    const start=addDays(weekStart(todayTs,anchor),-i*7);
    ranges.push({start:start,end:addDays(start,7)});
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

export { renderBank, toggleShadowList, renderShadowList, chartState, toggleChartSeries, toggleTrendMode, showChartTip, hideChartTip, drawChart, drawVitalityFlowChart, drawWeekCompareChart, renderRadar, renderMetricChips, setLedgerFilter, clearLedgerFilter, toggleLedgerShadowFilter, toggleLedgerDay, toggleLedgerDetail, focusLedgerLink };

registerRenderer('bank', renderBank);

// 面板级重绘入口（S3-B：能力已可用，现有调用点仍只走全量 render()）
registerPanelTarget('bank', renderBank);
registerPanelTarget('bank.logs', renderBankLogs);
