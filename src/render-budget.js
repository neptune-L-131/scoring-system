import { registerRenderer } from './render.js';
import { BudgetEngine } from './budget.js';
import { normalizeCondition } from './cond-model.js';
import { addCondGroup, addCondItem, renderCondTree, resetCondDraftUI, setCondDraftContext } from './cond-ui.js';
import { BUDGET_RULE_KINDS, BUDGET_RULE_NAMES, BUDGET_TARGET_NAMES } from './constants.js';
import { condNodeLabel, fmtDate } from './cycle.js';
import { Ledger } from './ledger.js';
import { closeModal, openModal } from './modal-host.js';
import { save } from './persist.js';
import { round4, weekAnchorName, esc, escAttr, fmt, now, uid } from './pure.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
// render-budget.js —— 渲染：现实预算页
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

let budEditingId='';
let budDraftRules=[];
let budCondEditIdx=-1;
let qrPreview=null;
let qrBasePlan=null;
let qrUseTopup=false;
// ===== Render: 现实预算 =====
function budgetPeriodLabel(cat,b){
  const d1=new Date(b.start),d2=new Date(b.end-1);
  if(cat.cycle==='month')return (d1.getMonth()+1)+'月（'+d1.getFullYear()+'）';
  return (d1.getMonth()+1)+'/'+d1.getDate()+' - '+(d2.getMonth()+1)+'/'+d2.getDate();
}
function budgetCatCardHTML(cat,ts){
  const r=BudgetEngine.readPeriod(cat,ts);
  const p=r.period||{spent:0,refund:0,entryCount:0,topupAmount:0,topupCost:0,penalizedOverspend:0,rewardSettled:false};
  const eff=BudgetEngine.effectiveLimit(cat,p);
  // 已花按“净花费”展示：跨期冲正退回的额度不再计入本期超支
  const refund=round4(Number(p.refund)||0);
  const net=BudgetEngine.netSpentOf(p);
  const over=Math.max(0,round4(net-eff));
  const remain=Math.max(0,round4(eff-net));
  const pct=eff>0?Math.min(100,Math.round(net/eff*100)):0;
  const reward=(cat.rules||[]).filter(function(x){return x.kind==='reward'&&x.enabled;}).length;
  const rules=(cat.rules||[]).filter(function(x){return x.enabled;});
  let html='<div class="bg-card'+(cat.enabled?'':' off')+'">';
  html+='<div class="bg-head"><div class="bg-name">'+esc(cat.name)+(cat.archived?' <span class="tag">已归档</span>':'')+'</div>';
  html+='<div class="bg-head-actions">';
  html+='<button class="btn btn-sm" onclick="openQuickRecordModal(\''+escAttr(cat.id)+'\')">记一笔</button>';
  html+='<button class="btn btn-sm" onclick="openBudgetCatModal(\''+escAttr(cat.id)+'\')">编辑</button>';
  html+='<button class="btn btn-sm" onclick="confirmDelBudgetCategory(\''+escAttr(cat.id)+'\')">删除</button>';
  html+='</div></div>';
  html+='<div class="bg-sub">'+(cat.cycle==='week'?('每周（'+weekAnchorName(cat.anchor)+'起）'):'每月')+' · '+budgetPeriodLabel(cat,r.b)+' · '+rules.length+' 条规则'+(reward?' · 含结余奖励':'')+'</div>';
  html+='<div class="bg-nums"><span>已花 <b>'+fmt(net)+'</b>'+(refund?'（冲正 -'+fmt(refund)+'）':'')+'</span><span>额度 <b>'+fmt(eff)+'</b>'+(p.topupAmount?'（基础 '+fmt(cat.limit)+' + 扩容 '+fmt(p.topupAmount)+'）':'')+'</span><span>剩余 <b>'+fmt(remain)+'</b></span><span>本期 '+fmt(p.entryCount||0)+' 笔</span></div>';
  html+='<div class="bg-bar"><div class="bg-bar-fill'+(over?' danger':'')+'" style="width:'+pct+'%"></div></div>';
  html+='<div class="bg-foot">';
  if(over)html+='<span class="bg-badge danger">超支 '+fmt(over)+'</span>';
  if(refund)html+='<span class="bg-badge">本期冲正 '+fmt(refund)+'</span>';
  if(p.topupAmount)html+='<span class="bg-badge">扩容 '+fmt(p.topupAmount)+'（花费 '+fmt(p.topupCost)+'）</span>';
  if(p.penalizedOverspend)html+='<span class="bg-badge">已计惩罚水位 '+fmt(p.penalizedOverspend)+'</span>';
  if(p.rewardSettled)html+='<span class="bg-badge ok">已结算'+(p.rewardAmount?' +'+fmt(p.rewardAmount):'')+'</span>';
  if(!cat.enabled)html+='<span class="bg-badge">已停用</span>';
  html+='</div>';
  const snap=p.settlementSnapshot;
  if(p.rewardSettled&&snap&&snap.rules&&snap.rules.length){
    html+='<div class="bg-settle">结算明细：'+snap.rules.map(function(x){
      const rule=(cat.rules||[]).find(function(y){return y.id===x.ruleId;});
      const acc=rule?BUDGET_TARGET_NAMES[rule.target&&rule.target.account]||'':'';
      return esc((acc?acc+' ':'')+'+'+fmt(x.amount));
    }).join('；')+'</div>';
  }
  if((cat.rules||[]).length){
    html+='<div class="bg-rules">'+cat.rules.map(function(rule){
      return '<span class="bg-rule '+(rule.kind||'')+(rule.enabled?'':' off')+'">'+BUDGET_RULE_NAMES[rule.kind]+'</span>';
    }).join('')+'</div>';
  }
  html+='</div>';
  return html;
}
// 账目来源文案：事项自动记账与跨期冲正都要能一眼看出“这笔现实账是哪来的”
const BUDGET_SRC_LABEL={manual:'手动',product:'商品',task:'任务',affair:'项目',chore:'杂事',reversal:'跨期冲正'};
function budgetSourceLabel(e){
  const base=BUDGET_SRC_LABEL[e.source]||'手动';
  if(e.source==='product'){
    const pr=state.products.find(function(x){return x.id===e.productId;});
    return base+'·'+(pr?pr.name:'已删除');
  }
  if(e.source==='task'){
    const log=e.links&&e.links.checkinLogId?state.logs.find(function(l){return l.id===e.links.checkinLogId;}):null;
    const task=log?state.tasks.find(function(x){return x.id===log.taskId;}):null;
    return base+(task?'·'+task.name:'');
  }
  if(e.source==='affair'){
    const a=state.affairs.find(function(x){return x.id===(e.links&&e.links.affairId);});
    return base+(a?'·'+a.name:'');
  }
  if(e.source==='chore'){
    const c=state.chores.find(function(x){return x.id===(e.links&&e.links.choreId);});
    return base+(c?'·'+c.name:'');
  }
  return base;
}
function budgetLedgerHTML(){
  const ledger=(state.ext.budgets.ledger||[]).slice().sort(function(a,b){return (b.ts||0)-(a.ts||0);});
  if(!ledger.length)return '<div class="empty" style="padding:18px"><p style="color:var(--text-3);margin:0">还没有现实账目 · 点「快速记账」或购买绑定商品时自动记录</p></div>';
  return ledger.slice(0,60).map(function(e){
    const cat=BudgetEngine.category(e.categoryId);
    const curKey=cat?BudgetEngine.bounds(cat.cycle,now()).key:'';
    // 冲正记录本身不可再撤（它携带的是 refund，不是一笔真实花费）
    const canRev=e.status==='active'&&cat&&e.source!=='reversal'&&e.periodKey===curKey;
    const src=budgetSourceLabel(e);
    const refundAmt=round4(Number(e.refundAmount)||0);
    let html='<div class="blog-row'+(e.status==='reversed'?' reversed':'')+(e.status==='compensated'?' compensated':'')+'">';
    html+='<div class="blog-main"><div class="blog-title">'+(cat?esc(cat.name):'已删除分类')+' · <b>'+(refundAmt?'冲正 '+fmt(refundAmt):fmt(e.amount))+'</b><span class="tag">'+esc(src)+'</span></div>';
    html+='<div class="blog-sub">'+fmtDate(e.ts)+' · '+budgetPeriodLabel(cat||{cycle:'week'},BudgetEngine.bounds((cat&&cat.cycle)||'week',e.ts))+(e.note?' · '+esc(e.note):'')+'</div>';
    if(e.topupAdded)html+='<div class="blog-sub">扩容 '+fmt(e.topupAdded)+'（花费 '+fmt(e.topupCost)+'）</div>';
    if(e.status==='compensated')html+='<div class="blog-sub">已于账期 '+(e.compensatedInPeriod||'')+' 冲正（历史周期与已发奖惩不变）</div>';
    const pen=(e.links.penaltyLogIds||[]).length,fed=(e.links.feedbackLogIds||[]).length;
    if(pen||fed)html+='<div class="blog-sub">'+(pen?'惩罚流水 '+pen+' 条':'')+(pen&&fed?' · ':'')+(fed?'反哺流水 '+fed+' 条':'')+'</div>';
    html+='</div>';
    html+='<div class="blog-act">';
    if(e.status==='reversed')html+='<span class="tag">已撤销</span>';
    else if(e.status==='compensated')html+='<span class="tag">已冲正</span>';
    else if(canRev)html+='<button class="btn btn-sm" onclick="confirmReverseBudgetEntry(\''+escAttr(e.id)+'\')">撤销</button>';
    else if(e.source==='reversal')html+='<span class="tag">冲正入账</span>';
    else html+='<span class="tag">跨期不可撤销</span>';
    html+='</div></div>';
    return html;
  }).join('');
}
function renderBudget(){
  const cats=BudgetEngine.categories();
  const ts=now();
  const notice=document.getElementById('budgetAnchorNotice');
  if(notice){
    const n=BudgetEngine.settings().anchorNotice;
    notice.innerHTML=(n&&n.name)
      ?'<div class="card" style="margin-bottom:10px;padding:10px 12px;display:flex;gap:10px;align-items:center;justify-content:space-between"><div style="font-size:13px;line-height:1.5">「'+esc(n.name)+'」的周起始日已从 <b>'+weekAnchorName(n.from)+'</b> 改为 <b>'+weekAnchorName(n.to)+'</b>：旧账期已保留（已花金额不丢失），新账期从 0 开始。</div><button class="btn btn-sm" onclick="dismissBudgetAnchorNotice()">知道了</button></div>'
      :'';
  }
  let totalLimit=0,totalSpent=0;
  cats.forEach(function(c){
    const r=BudgetEngine.readPeriod(c,ts);
    totalLimit+=Number(c.limit)||0;
    totalSpent+=BudgetEngine.netSpentOf(r.period);
  });
  const per=document.getElementById('bPeriod');
  if(per)per.textContent=cats.length?fmt(totalSpent)+' / '+fmt(totalLimit):'—';
  const sub=document.getElementById('bPeriodSub');
  if(sub)sub.textContent=cats.filter(function(c){return c.enabled&&!c.archived;}).length+' 个启用分类';
  const box=document.getElementById('budgetCategories');
  if(box){
    box.innerHTML=cats.length?cats.map(function(c){return budgetCatCardHTML(c,ts);}).join('')
      :'<div class="empty" style="padding:24px"><p style="color:var(--text-3)">还没有预算分类。先新建一个「餐饮」或「娱乐」分类，再给它加规则。</p><button class="btn" onclick="openBudgetCatModal()">+ 新建第一个分类</button></div>';
  }
  const list=document.getElementById('budgetLedgerList');
  if(list)list.innerHTML=budgetLedgerHTML();
  const meta=document.getElementById('budgetLedgerMeta');
  if(meta)meta.textContent=(state.ext.budgets.ledger||[]).length+' 条 · 上限 '+BudgetEngine.settings().ledgerMax;
}
function confirmReverseBudgetEntry(id){
  if(confirm('撤销这笔现实账目？\n惩罚/反哺流水会一并退回；扩容在不会立刻制造超支时退回。'))BudgetEngine.reverseEntry(id);
}
function fillBudgetDomainSelect(selected){
  const sel=document.getElementById('budgetCatDefaultDomain');
  if(!sel)return;
  sel.innerHTML='<option value="">不设置（进度类规则需单独选领域）</option>'+state.domains.map(function(d){
    return '<option value="'+escAttr(d.id)+'"'+(d.id===selected?' selected':'')+'>'+esc(d.name)+(d.archived?'（已归档）':'')+'</option>';
  }).join('');
}
function budgetRuleDefault(kind){
  const rule={
    id:uid(),kind:kind,enabled:true,priority:budDraftRules.length+1,
    when:{mode:'all',items:[]},
    target:{account:kind==='feedback'?'progress':(kind==='penalty'?'vitality':'achievement'),domainId:''},
    params:{mode:'ratio',value:10,rate:kind==='penalty'?1:(kind==='reward'?0.1:1),capPerPeriod:null,minAmount:0,per:'episode'}
  };
  if(kind==='penalty'){
    rule.when.items=[{range:'period',metric:'budget_period_overspend',op:'>',value:0,targetType:'all',target:'',newFilter:'none',aggregate:'sum'}];
  }
  if(kind==='feedback')rule.params.rate=1;
  if(kind==='reward'){
    rule.params.mode='ratio';
    rule.params.rate=0.1;
  }
  return rule;
}
function budgetWhenSummary(when){
  const c=normalizeCondition(when||{});
  if(!c.items.length)return '总是';
  return condNodeLabel({group:true,mode:c.mode,items:c.items});
}
function budgetCondPreview(el,draft){
  const c=normalizeCondition(draft||{});
  el.innerHTML='<span class="cond-preview-label">条件：</span>'+esc(budgetWhenSummary(c))+'<span class="h"> · 预算指标按记账后的当期实时数据计算</span>';
}
function budgetRuleCardHTML(rule,idx){
  const kind=rule.kind;
  const target=rule.target||{};
  const p=rule.params||{};
  const isProgress=target.account==='progress';
  const editing=budCondEditIdx===idx;
  const accountOpts=['vitality','achievement','progress'].map(function(k){
    return '<option value="'+k+'"'+(target.account===k?' selected':'')+'>'+BUDGET_TARGET_NAMES[k]+'</option>';
  }).join('');
  const kindOpts=BUDGET_RULE_KINDS.map(function(k){
    return '<option value="'+k+'"'+(kind===k?' selected':'')+'>'+BUDGET_RULE_NAMES[k]+'</option>';
  }).join('');
  const domainOpts='<option value="">使用分类默认领域</option>'+state.domains.map(function(d){
    return '<option value="'+escAttr(d.id)+'"'+(target.domainId===d.id?' selected':'')+'>'+esc(d.name)+(d.archived?'（已归档）':'')+'</option>';
  }).join('');
  let html='<div class="brule-card" data-idx="'+idx+'">';
  html+='<div class="brule-head">';
  html+='<span class="brule-no">规则 '+(idx+1)+'</span>';
  html+='<select class="br-kind" onchange="budRuleKindChanged('+idx+',this.value)">'+kindOpts+'</select>';
  html+='<label class="brule-en"><input type="checkbox" class="br-enabled" '+(rule.enabled?'checked':'')+'> 启用</label>';
  html+='<input class="br-priority" type="number" min="0" step="1" value="'+(Number(rule.priority)||0)+'" title="优先级（数字小的先执行）">';
  html+='<button class="btn btn-sm" onclick="budRuleMove('+idx+',-1)" title="上移">↑</button>';
  html+='<button class="btn btn-sm" onclick="budRuleMove('+idx+',1)" title="下移">↓</button>';
  html+='<button class="btn btn-sm" onclick="budRuleDelete('+idx+')">删除</button>';
  html+='</div>';
  html+='<div class="brule-when"><span class="br-when-sum">当：'+esc(budgetWhenSummary(rule.when))+'</span>';
  html+='<button class="btn btn-sm" onclick="'+(editing?'budRuleDoneWhen('+idx+')':'budRuleEditWhen('+idx+')')+'">'+(editing?'完成条件':'编辑条件')+'</button></div>';
  html+='<div class="brule-grid">';
  html+='<div class="fg"><label>目标</label><select class="br-account" onchange="budRuleAccountChanged('+idx+',this.value)">'+accountOpts+'</select></div>';
  html+='<div class="fg br-domain" style="'+(isProgress?'':'display:none')+'"><label>领域 <span class="h">留空用分类默认</span></label><select class="br-domain-sel">'+domainOpts+'</select></div>';
  html+='<div class="fg"><label>模式</label><select class="br-mode" onchange="budRuleModeChanged('+idx+',this.value)"><option value="fixed"'+(p.mode==='fixed'?' selected':'')+'>固定值</option><option value="ratio"'+(p.mode==='ratio'?' selected':'')+'>按比例</option></select></div>';
  html+='<div class="fg br-fixed" style="'+(p.mode==='fixed'?'':'display:none')+'"><label>固定值</label><input class="br-value" type="number" min="0" step="0.01" value="'+(Number(p.value)||0)+'"></div>';
  html+='<div class="fg br-ratio" style="'+(p.mode==='ratio'?'':'display:none')+'"><label>系数</label><input class="br-rate" type="number" min="0" step="0.01" value="'+(Number(p.rate)||0)+'"><div class="h">'+kindBaseHint(kind)+'</div></div>';
  if(kind==='penalty')html+='<div class="fg"><label>触发粒度</label><select class="br-per"><option value="episode"'+(p.per==='episode'?' selected':'')+'>每期首次超支</option><option value="entry"'+(p.per==='entry'?' selected':'')+'>每次满足条件</option></select></div>';
  html+='<div class="fg"><label>每期上限 <span class="h">留空不限</span></label><input class="br-cap" type="number" min="0" step="0.01" value="'+(p.capPerPeriod===null||p.capPerPeriod===undefined?'':(Number(p.capPerPeriod)||0))+'"></div>';
  html+='<div class="fg"><label>最低值</label><input class="br-min" type="number" min="0" step="0.01" value="'+(Number(p.minAmount)||0)+'"></div>';
  html+='</div>';
  if(editing){
    html+='<div class="brule-editor">';
    html+='<div class="fg"><label>满足方式 <span class="h">只作用于这条规则</span></label><select id="budCondMode" onchange="budCondModeChange('+idx+',this.value)"><option value="all"'+(normalizeCondition(rule.when).mode==='all'?' selected':'')+'>全部满足（且）</option><option value="any"'+(normalizeCondition(rule.when).mode==='any'?' selected':'')+'>任一满足（或）</option></select></div>';
    html+='<div id="budCondItems"></div>';
    html+='<div class="cond-actions" style="margin-top:6px"><button class="btn btn-sm" onclick="addCondItem(\'\')">+ 添加条件</button><button class="btn btn-sm" onclick="addCondGroup(\'\')">+ 添加条件组</button></div>';
    html+='<div class="cond-preview" id="budCondPreview"></div>';
    html+='</div>';
  }
  html+='</div>';
  return html;
}
function kindBaseHint(kind){
  if(kind==='penalty')return '按超支增量 × 系数';
  if(kind==='feedback')return '按本笔金额 × 系数';
  return '按期结余 × 系数';
}
function renderBudgetRuleList(){
  const box=document.getElementById('budgetRuleList');
  if(!box)return;
  if(!budDraftRules.length){
    box.innerHTML='<div class="empty" style="padding:14px"><p style="color:var(--text-3);margin:0">还没有规则。加一条惩罚、奖励或反哺规则，它就会在记账时自动生效。</p></div>';
    budCondEditIdx=-1;
    resetCondDraftUI();
    return;
  }
  box.innerHTML=budDraftRules.map(function(r,i){return budgetRuleCardHTML(r,i);}).join('');
  if(budCondEditIdx>=0&&budDraftRules[budCondEditIdx]){
    const rule=budDraftRules[budCondEditIdx];
    setCondDraftContext(rule.when,'budCondItems','budCondPreview',budgetCondPreview,function(){
      budgetUpdateWhenSummary(budCondEditIdx);
    });
    renderCondTree();
  }else{
    resetCondDraftUI();
  }
}
function budgetUpdateWhenSummary(idx){
  const rule=budDraftRules[idx];
  const el=document.querySelector('.brule-card[data-idx="'+idx+'"] .br-when-sum');
  if(el&&rule)el.textContent='当：'+budgetWhenSummary(rule.when);
}
function collectBudgetRulesFromDOM(){
  document.querySelectorAll('#budgetRuleList .brule-card').forEach(function(card){
    const i=Number(card.dataset.idx);
    const r=budDraftRules[i];
    if(!r)return;
    const q=function(sel){return card.querySelector(sel);};
    r.kind=q('.br-kind')?q('.br-kind').value:r.kind;
    r.enabled=q('.br-enabled')?q('.br-enabled').checked:r.enabled;
    r.priority=q('.br-priority')?Math.round(Number(q('.br-priority').value)||0):r.priority;
    if(q('.br-account'))r.target.account=q('.br-account').value;
    if(q('.br-domain-sel'))r.target.domainId=q('.br-domain-sel').value;
    if(q('.br-mode'))r.params.mode=q('.br-mode').value;
    if(q('.br-value'))r.params.value=Math.max(0,Number(q('.br-value').value)||0);
    if(q('.br-rate'))r.params.rate=Math.max(0,Number(q('.br-rate').value)||0);
    if(q('.br-per'))r.params.per=q('.br-per').value;
    if(q('.br-cap')){
      const raw=q('.br-cap').value;
      r.params.capPerPeriod=raw===''?null:Math.max(0,Number(raw)||0);
    }
    if(q('.br-min'))r.params.minAmount=Math.max(0,Number(q('.br-min').value)||0);
  });
}
function budRuleAdd(kind){
  collectBudgetRulesFromDOM();
  budDraftRules.push(budgetRuleDefault(kind));
  budCondEditIdx=-1;
  renderBudgetRuleList();
}
function budRuleDelete(idx){
  collectBudgetRulesFromDOM();
  budDraftRules.splice(idx,1);
  if(budCondEditIdx===idx)budCondEditIdx=-1;
  else if(budCondEditIdx>idx)budCondEditIdx--;
  renderBudgetRuleList();
}
function budRuleMove(idx,dir){
  collectBudgetRulesFromDOM();
  const to=idx+dir;
  if(to<0||to>=budDraftRules.length)return;
  const tmp=budDraftRules[idx];
  budDraftRules[idx]=budDraftRules[to];
  budDraftRules[to]=tmp;
  budDraftRules.forEach(function(r,i){r.priority=i+1;});
  if(budCondEditIdx===idx)budCondEditIdx=to;
  else if(budCondEditIdx===to)budCondEditIdx=idx;
  renderBudgetRuleList();
}
function budRuleKindChanged(idx,kind){
  collectBudgetRulesFromDOM();
  const r=budDraftRules[idx];
  if(!r)return;
  const def=budgetRuleDefault(kind);
  r.kind=kind;
  r.params.per=def.params.per;
  if(r.params.mode==='ratio'&&r.params.rate<=0)r.params.rate=def.params.rate;
  if(kind==='reward')r.params.mode='ratio';
  if(kind==='feedback'&&r.target.account!=='vitality')r.target.account='progress';
  renderBudgetRuleList();
}
function budRuleAccountChanged(idx,val){
  const card=document.querySelector('.brule-card[data-idx="'+idx+'"]');
  const row=card&&card.querySelector('.br-domain');
  if(row)row.style.display=val==='progress'?'':'none';
}
function budRuleModeChanged(idx,val){
  const card=document.querySelector('.brule-card[data-idx="'+idx+'"]');
  if(!card)return;
  const f=card.querySelector('.br-fixed'),r=card.querySelector('.br-ratio');
  if(f)f.style.display=val==='fixed'?'':'none';
  if(r)r.style.display=val==='ratio'?'':'none';
}
function budRuleEditWhen(idx){
  collectBudgetRulesFromDOM();
  budCondEditIdx=idx;
  renderBudgetRuleList();
}
function budRuleDoneWhen(idx){
  collectBudgetRulesFromDOM();
  budCondEditIdx=-1;
  renderBudgetRuleList();
}
function budCondModeChange(idx,val){
  if(!budDraftRules[idx])return;
  budDraftRules[idx].when=normalizeCondition(budDraftRules[idx].when);
  budDraftRules[idx].when.mode=val==='any'?'any':'all';
  renderCondTree();
}
function openBudgetCatModal(id){
  const cat=id?BudgetEngine.category(id):null;
  budEditingId=cat?cat.id:'';
  budDraftRules=cat?JSON.parse(JSON.stringify(cat.rules||[])):[];
  budCondEditIdx=-1;
  const title=document.getElementById('budgetCatTitle');
  if(title)title.textContent=cat?'编辑预算分类':'新建预算分类';
  document.getElementById('budgetCatName').value=cat?cat.name:'';
  document.getElementById('budgetCatCycle').value=cat?cat.cycle:'week';
  document.getElementById('budgetCatAnchor').value=String(cat?(cat.anchor||1):1);
  syncBudgetAnchorVisibility();
  document.getElementById('budgetCatLimit').value=cat?cat.limit:300;
  document.getElementById('budgetCatEnabled').checked=cat?cat.enabled!==false:true;
  fillBudgetDomainSelect(cat?cat.defaultProgressDomainId:'');
  const od=(cat&&cat.overdraft)||{enabled:false,currency:'achievement',rate:2,maxCostPerPeriod:150};
  document.getElementById('budgetOdEnabled').checked=!!od.enabled;
  document.getElementById('budgetOdCurrency').value=od.currency||'achievement';
  document.getElementById('budgetOdRate').value=od.rate||2;
  document.getElementById('budgetOdMaxCost').value=od.maxCostPerPeriod!==undefined?od.maxCostPerPeriod:150;
  renderBudgetRuleList();
  openModal('budgetCatModal');
  setTimeout(function(){document.getElementById('budgetCatName').focus();},50);
}
function syncBudgetAnchorVisibility(){
  const cycleEl=document.getElementById('budgetCatCycle');
  const wrap=document.getElementById('budgetCatAnchorWrap');
  if(!cycleEl||!wrap)return;
  wrap.style.display=cycleEl.value==='week'?'':'none';
}
function dismissBudgetAnchorNotice(){
  const s=BudgetEngine.settings();
  s.anchorNotice=null;
  save();
  renderBudget();
}
function saveBudgetCategory(){
  collectBudgetRulesFromDOM();
  const name=document.getElementById('budgetCatName').value.trim();
  const cycle=document.getElementById('budgetCatCycle').value==='month'?'month':'week';
  const anchor=Math.min(7,Math.max(1,Math.round(Number(document.getElementById('budgetCatAnchor').value)||1)));
  const limit=Number(document.getElementById('budgetCatLimit').value);
  const enabled=document.getElementById('budgetCatEnabled').checked;
  const did=document.getElementById('budgetCatDefaultDomain').value;
  const odEnabled=document.getElementById('budgetOdEnabled').checked;
  const odCurrency=document.getElementById('budgetOdCurrency').value==='vitality'?'vitality':'achievement';
  const odRate=Number(document.getElementById('budgetOdRate').value);
  const odMaxCost=Number(document.getElementById('budgetOdMaxCost').value);
  if(!name){toast('请填写分类名称','err');return}
  if(!isFinite(limit)||limit<=0){toast('基础限额必须大于 0','err');return}
  if(did&&!state.domains.some(function(d){return d.id===did;})){toast('默认领域不存在','err');return}
  if(odEnabled&&(!isFinite(odRate)||odRate<=0)){toast('扩容汇率必须大于 0','err');return}
  if(!isFinite(odMaxCost)||odMaxCost<0){toast('扩容花费上限不能为负','err');return}
  // 「每期最多扩额度」不再单独填写：由花费上限 × 汇率自动换算（与引擎校验同一口径）
  const odRateSafe=isFinite(odRate)&&odRate>0?odRate:2;
  const odMaxReality=odMaxCost*odRateSafe;
  const catProto={
    defaultProgressDomainId:did,name:name,cycle:cycle,
    rules:budDraftRules.slice().sort(function(a,b){return (a.priority||0)-(b.priority||0);})
  };
  for(let i=0;i<budDraftRules.length;i++){
    const issue=BudgetEngine.validateRule(catProto,budDraftRules[i],i+1);
    if(issue){toast(issue,'err');return;}
  }
  const bd=state.ext.budgets;
  const old=budEditingId?BudgetEngine.category(budEditingId):null;
  // 周期从周切到月（或反向）时，周期键前缀不同（W: / M:），已花金额无法无损换算；
  // 周起始日变化会让“当前周”的键变化，同样无法把旧账期无损映射到新账期。
  // 两种变更都采用「显式开启新账期」：先结清已经自然结束的旧周期，再把剩余旧周期只读归档，
  // 新周期从 0 开始。旧账期本身不删除，已花金额完整保留在历史周期里。
  const cycleChanged=!!(old&&old.cycle!==cycle);
  const anchorChanged=!!(old&&!cycleChanged&&old.cycle==='week'&&Number(old.anchor||1)!==anchor);
  if(anchorChanged){
    const ok=confirm('将「'+old.name+'」的周起始日从 '+weekAnchorName(old.anchor)+' 改为 '+weekAnchorName(anchor)+'？\n\n旧账期会完整保留（已花金额不丢失）；新账期从 0 开始。');
    if(!ok)return;
  }
  if(cycleChanged||anchorChanged){
    BudgetEngine.reconcileDue(old.id,now());
    const map=bd.periods[old.id]||{};
    Object.keys(map).forEach(function(k){
      const p=map[k];
      if(!p)return;
      if(!p.rewardSettled){
        p.rewardSettled=true;
        p.settlementSnapshot=Object.assign({},p.settlementSnapshot||{},{
          reason:cycleChanged?'cycle-change':'anchor-change',cycle:old.cycle,anchor:old.anchor||1,
          spent:round4(Number(p.spent)||0),overspend:BudgetEngine.overspendOf(old,p)
        });
      }
      p.closedAt=p.end;
    });
    delete bd.current[old.id];
  }
  const cat={
    id:budEditingId||uid(),name:name.slice(0,40),enabled:enabled,archived:old?!!old.archived:false,
    cycle:cycle,anchor:anchor,limit:round4(limit),defaultProgressDomainId:did,
    rules:JSON.parse(JSON.stringify(budDraftRules)).sort(function(a,b){return (a.priority||0)-(b.priority||0);}),
    overdraft:{enabled:odEnabled,currency:odCurrency,rate:Math.max(0.0001,odRateSafe),maxRealityPerPeriod:Math.max(0,round4(odMaxReality)),maxCostPerPeriod:Math.max(0,round4(odMaxCost))},
    createdAt:old?old.createdAt:now(),updatedAt:now()
  };
  const idx=bd.categories.findIndex(function(c){return c.id===cat.id;});
  if(idx>=0)bd.categories[idx]=cat;else bd.categories.push(cat);
  if(anchorChanged){
    bd.settings.anchorNotice={categoryId:cat.id,name:cat.name,from:Number(old.anchor||1),to:anchor,at:now()};
    Ledger.event('预算分类「'+cat.name+'」周起始日 '+weekAnchorName(old.anchor)+' → '+weekAnchorName(anchor)+'，旧账期已归档','budget-anchor',{categoryId:cat.id});
  }else if(cycleChanged){
    bd.settings.anchorNotice=null;
  }
  save();render();
  closeModal('budgetCatModal');
  toast(old?(cycleChanged?'预算分类已更新：旧账期已归档，新账期从 0 开始'
    :(anchorChanged?'周起始日已改为'+weekAnchorName(anchor)+'：旧账期保留，新账期从 0 开始':'预算分类已更新')):'预算分类已创建');
}
function confirmDelBudgetCategory(id){
  const cat=BudgetEngine.category(id);
  if(!cat)return;
  if(!confirm('删除预算分类「'+cat.name+'」？\n（该分类的周期实例与账本明细会一并删除；商品绑定会解除）'))return;
  const bd=state.ext.budgets;
  bd.categories=bd.categories.filter(function(c){return c.id!==id;});
  delete bd.current[id];
  delete bd.periods[id];
  bd.ledger=(bd.ledger||[]).filter(function(e){return e.categoryId!==id;});
  state.products.forEach(function(p){if(p.budget&&p.budget.categoryId===id)p.budget={categoryId:'',amount:0};});
  save();render();
  toast('预算分类已删除');
}
function openQuickRecordModal(catId){
  const cats=BudgetEngine.categories().filter(function(c){return c.enabled&&!c.archived;});
  if(!cats.length){
    toast('请先创建一个可用的预算分类','err');
    openBudgetCatModal();
    return;
  }
  const sel=document.getElementById('qrCategory');
  sel.innerHTML=cats.map(function(c){
    return '<option value="'+escAttr(c.id)+'">'+esc(c.name)+'</option>';
  }).join('');
  const def=(catId&&cats.some(function(c){return c.id===catId;}))?catId:cats[0].id;
  sel.value=def;
  document.getElementById('qrAmount').value='';
  document.getElementById('qrNote').value='';
  qrUseTopup=false;
  qrPreview=null;
  qrBasePlan=null;
  renderQuickPreview();
  openModal('quickRecordModal');
  setTimeout(function(){document.getElementById('qrAmount').focus();},50);
}
function qrToggleTopup(on){
  qrUseTopup=!!on;
  renderQuickPreview();
}
function renderQuickPreview(){
  const box=document.getElementById('qrPreview');
  const btn=document.getElementById('qrConfirmBtn');
  if(!box)return;
  const catId=document.getElementById('qrCategory')?document.getElementById('qrCategory').value:'';
  const amount=parseFloat(document.getElementById('qrAmount').value);
  if(!catId||!isFinite(amount)||amount<=0){
    qrPreview=null;qrBasePlan=null;
    box.innerHTML='<div class="qr-hint">输入金额后，这里会实时显示本期已花、是否超支、惩罚/反哺与扣后余额。预览是只读的。</div>';
    if(btn)btn.disabled=true;
    return;
  }
  qrBasePlan=BudgetEngine.preview(catId,amount,now(),{});
  let plan=qrBasePlan;
  if(qrUseTopup&&qrBasePlan&&qrBasePlan.needsTopup&&qrBasePlan.needsTopup.affordable){
    plan=BudgetEngine.preview(catId,amount,now(),{topup:qrBasePlan.needsTopup.amount});
  }
  qrPreview=plan;
  box.innerHTML=budgetPreviewHTML(plan,qrBasePlan);
  if(btn)btn.disabled=!(plan&&plan.ok&&!plan.insufficient);
}
function budgetAccountRow(k,s){
  const b=s.balances&&s.balances[k];
  if(!b)return'';
  const delta=b.delta?(' <span class="'+(b.delta<0?'neg':'pos')+'">'+(b.delta>0?'+':'')+fmt(b.delta)+'</span>'):'';
  return '<div class="qr-bal"><span>'+BUDGET_TARGET_NAMES[k]+'</span><span>'+fmt(b.before)+' → <b class="'+(b.after<0?'neg':'')+'">'+fmt(b.after)+'</b>'+delta+'</span></div>';
}
function budgetPreviewHTML(plan,base){
  if(!plan||!plan.ok)return '<div class="qr-alert danger">'+esc((plan&&plan.reason)||'预览失败')+'</div>';
  let html='<div class="qr-panel">';
  html+='<div class="qr-panel-head">'+esc(plan.cat.name)+' · 本期 '+esc(budgetPeriodLabel(plan.cat,plan.bounds))+'</div>';
  html+='<div class="qr-line"><span>本期已花</span><span>'+fmt(plan.netBefore!==undefined?plan.netBefore:plan.spentBefore)+' → <b>'+fmt(plan.netAfter!==undefined?plan.netAfter:plan.spentAfter)+'</b></span></div>';
  if(plan.refund)html+='<div class="qr-line"><span>本期冲正</span><span>-'+fmt(plan.refund)+'（不计入结余奖励）</span></div>';
  html+='<div class="qr-line"><span>有效额度</span><span>'+fmt(plan.limitAfter)+(plan.topup.amount?'（含本次扩容 '+fmt(plan.topup.amount)+'）':'')+'</span></div>';
  if(plan.overspendAfter)html+='<div class="qr-line danger"><span>本期超支</span><span>'+fmt(plan.overspendAfter)+(plan.deltaOverspend?' · 本次新增 '+fmt(plan.deltaOverspend):'')+'</span></div>';
  if(plan.effects&&plan.effects.length){
    html+='<div class="qr-effects">';
    plan.effects.forEach(function(e){
      html+='<div class="qr-effect '+(e.kind==='penalty'?'danger':'ok')+'">'+esc(e.desc)+'</div>';
    });
    html+='</div>';
  }else{
    html+='<div class="qr-effect muted">本次不触发惩罚或反哺</div>';
  }
  if(plan.topup.amount){
    html+='<div class="qr-line"><span>扩容花费</span><span>-'+fmt(plan.topup.cost)+' '+BUDGET_TARGET_NAMES[plan.topup.currency]+'</span></div>';
  }
  html+='<div class="qr-balance">'+budgetAccountRow('vitality',plan)+budgetAccountRow('achievement',plan)+'</div>';
  if(plan.rewardPreview&&plan.rewardPreview.length){
    html+='<div class="qr-hint">期末若保持结余，预计奖励：'+plan.rewardPreview.map(function(e){return esc(e.desc)}).join('；')+'</div>';
  }
  // 超支预警 / 扩容建议
  if(base&&base.needsTopup&&!plan.topup.amount){
    const n=base.needsTopup;
    html+='<div class="qr-alert'+(n.affordable?'':' danger')+'">';
    html+='本次记账会让本期超支 '+fmt(base.overspendAfter)+'。';
    if(n.affordable){
      html+='可扩容 '+fmt(n.amount)+'（花 '+fmt(n.cost)+' '+BUDGET_TARGET_NAMES[n.currency]+'）'+
        '<label class="qr-topup"><input type="checkbox" '+(qrUseTopup?'checked':'')+' onchange="qrToggleTopup(this.checked)"> 扩容并记账</label>';
    }else{
      html+=esc(n.reason||'扩容额度或货币不足');
    }
    html+='</div>';
  }else if(base&&base.overspendAfter>0){
    html+='<div class="qr-alert danger">本次记账会让本期超支 '+fmt(base.overspendAfter)+'，确认后将按规则结算惩罚。</div>';
  }
  if(plan.insufficient){
    html+='<div class="qr-alert danger">'+esc(plan.insufficient.reason)+' · 整笔将被拒绝，不会只记一半。</div>';
  }
  html+='</div>';
  return html;
}
function quickRecordBudget(catId,amount,note,ts,opts){
  ts=Number(ts)||now();
  opts=opts||{};
  let plan=null;
  const r=Ledger.txn(function(tx){
    BudgetEngine.reconcileDue(catId,ts);
    plan=BudgetEngine.prepareEntry(catId,amount,{source:'manual',note:note,ts:ts,topup:opts.topup||0});
    return BudgetEngine.commitEntry(tx,plan);
  },{label:'budget-record',save:'none',render:false});
  if(!r.ok){
    const info=(r.error&&r.error.info)||{};
    toast(info.reason||'记账失败','err');
    return{ok:false,error:r.error};
  }
  let msg='已记「'+plan.cat.name+'」'+fmt(plan.amount);
  (plan.effects||[]).forEach(function(e){msg+=' · '+e.desc});
  if(plan.topup.amount)msg+=' · 扩容 '+fmt(plan.topup.amount)+'（-'+fmt(plan.topup.cost)+' '+BUDGET_TARGET_NAMES[plan.topup.currency]+'）';
  save();render();toast(msg);
  return{ok:true,plan:plan,result:r.value};
}
function qrConfirm(){
  const catId=document.getElementById('qrCategory').value;
  const amount=parseFloat(document.getElementById('qrAmount').value);
  const note=document.getElementById('qrNote').value.trim();
  if(!catId){toast('请选择预算分类','err');return}
  if(!isFinite(amount)||amount<=0){toast('请输入大于 0 的金额','err');return}
  let topup=0;
  if(qrUseTopup&&qrBasePlan&&qrBasePlan.needsTopup&&qrBasePlan.needsTopup.affordable)topup=qrBasePlan.needsTopup.amount;
  const res=quickRecordBudget(catId,amount,note,now(),{topup:topup});
  if(res.ok){
    closeModal('quickRecordModal');
    qrUseTopup=false;
    qrPreview=null;
    qrBasePlan=null;
  }
}

export { budEditingId, budDraftRules, budCondEditIdx, qrPreview, qrBasePlan, qrUseTopup, budgetPeriodLabel, budgetCatCardHTML, budgetLedgerHTML, renderBudget, confirmReverseBudgetEntry, fillBudgetDomainSelect, budgetRuleDefault, budgetWhenSummary, budgetCondPreview, budgetRuleCardHTML, kindBaseHint, renderBudgetRuleList, budgetUpdateWhenSummary, collectBudgetRulesFromDOM, budRuleAdd, budRuleDelete, budRuleMove, budRuleKindChanged, budRuleAccountChanged, budRuleModeChanged, budRuleEditWhen, budRuleDoneWhen, budCondModeChange, openBudgetCatModal, syncBudgetAnchorVisibility, dismissBudgetAnchorNotice, saveBudgetCategory, confirmDelBudgetCategory, openQuickRecordModal, qrToggleTopup, renderQuickPreview, budgetAccountRow, budgetPreviewHTML, quickRecordBudget, qrConfirm };

registerRenderer('budget', renderBudget);
