import { registerRenderer } from './render.js';
import { BudgetEngine } from './budget.js';
import { runCommand } from './command.js';
import { normalizeCondition } from './cond-model.js';
import { addCondGroup, addCondItem, renderCondTree, resetCondDraftUI, setCondDraftContext } from './cond-ui.js';
import { BUDGET_RULE_KINDS, BUDGET_RULE_NAMES, BUDGET_TARGET_NAMES, CURRENCIES } from './constants.js';
import { condNodeLabel, fmtDate } from './cycle.js';
import { Ledger } from './ledger.js';
import { closeModal, openModal } from './modal-host.js';
import { markModalClean, rejectFields } from './form-contract.js';
import { save } from './persist.js';
import { round4, weekAnchorName, esc, escAttr, fmt, now, uid, currencyOf, historicalCurrencyOf, money, isCurrencyCode } from './pure.js';
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
// 退回与跨期冲正都计入 p.refund，但账本来源不同：展示时分开，避免“退回”被误读成“撤销”
function refundBreakdown(cat,periodKey,refundTotal){
  let refund=0,reversal=0;
  (state.ext.budgets.ledger||[]).forEach(function(e){
    if(!e||e.categoryId!==cat.id||e.periodKey!==periodKey||e.status!=='active')return;
    const amt=round4(Number(e.refundAmount)||0);
    if(!amt)return;
    if(e.source==='refund')refund=round4(refund+amt);
    else if(e.source==='reversal')reversal=round4(reversal+amt);
  });
  // 账本已被裁剪但周期仍保留 refund：余额差按冲正展示，不丢金额
  const known=round4(refund+reversal);
  if(refundTotal>known)reversal=round4(reversal+(refundTotal-known));
  return{refund:refund,reversal:reversal};
}
function budgetCatCardHTML(cat,ts){
  const r=BudgetEngine.readPeriod(cat,ts);
  const p=r.period||{spent:0,refund:0,entryCount:0,topupAmount:0,topupCost:0,penalizedOverspend:0,rewardSettled:false};
  const eff=BudgetEngine.effectiveLimit(cat,p);
  // 已花按“净花费”展示：跨期冲正与主动退回的额度都不再计入本期超支
  const refund=round4(Number(p.refund)||0);
  const rb=refundBreakdown(cat,r.b.key,refund);
  const refundNote=(rb.refund?'退回 -'+fmt(rb.refund):'')+(rb.refund&&rb.reversal?' · ':'')+(rb.reversal?'冲正 -'+fmt(rb.reversal):'');
  const net=BudgetEngine.netSpentOf(p);
  const over=Math.max(0,round4(net-eff));
  const remain=Math.max(0,round4(eff-net));
  const pct=eff>0?Math.min(100,Math.round(net/eff*100)):0;
  const reward=(cat.rules||[]).filter(function(x){return x.kind==='reward'&&x.enabled;}).length;
  const rules=(cat.rules||[]).filter(function(x){return x.enabled;});
  const cur=currencyOf(cat);
  let html='<div class="bg-card'+(cat.enabled?'':' off')+'">';
  html+='<div class="bg-head"><div class="bg-name">'+esc(cat.name)+(cur!=='CNY'?' <span class="tag">'+esc(cur)+'</span>':'')+(cat.archived?' <span class="tag">已归档</span>':'')+'</div>';
  html+='<div class="bg-head-actions">';
  html+='<button class="btn btn-sm" onclick="openQuickRecordModal(\''+escAttr(cat.id)+'\')">记一笔</button>';
  html+='<button class="btn btn-sm" onclick="openBudgetCatModal(\''+escAttr(cat.id)+'\')">编辑</button>';
  html+='<button class="btn btn-sm" onclick="confirmDelBudgetCategory(\''+escAttr(cat.id)+'\')">删除</button>';
  html+='</div></div>';
  html+='<div class="bg-sub">'+(cat.cycle==='week'?('每周（'+weekAnchorName(cat.anchor)+'起）'):'每月')+' · '+budgetPeriodLabel(cat,r.b)+' · '+rules.length+' 条规则'+(reward?' · 含结余奖励':'')+'</div>';
  html+='<div class="bg-nums"><span>已花 <b>'+fmt(net)+'</b>'+(refundNote?'（'+refundNote+'）':'')+'</span><span>额度 <b>'+fmt(eff)+'</b>'+(p.topupAmount?'（基础 '+fmt(cat.limit)+' + 扩容 '+fmt(p.topupAmount)+'）':'')+'</span><span>剩余 <b>'+fmt(remain)+'</b></span><span>本期 '+fmt(p.entryCount||0)+' 笔</span></div>';
  html+='<div class="bg-bar"><div class="bg-bar-fill'+(over?' danger':'')+'" style="width:'+pct+'%"></div></div>';
  html+='<div class="bg-foot">';
  if(over)html+='<span class="bg-badge danger">超支 '+fmt(over)+'</span>';
  if(rb.refund)html+='<span class="bg-badge">本期退回 '+fmt(rb.refund)+'</span>';
  if(rb.reversal)html+='<span class="bg-badge">本期冲正 '+fmt(rb.reversal)+'</span>';
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
const BUDGET_SRC_LABEL={manual:'手动',product:'商品',task:'任务',affair:'项目',chore:'杂事',reversal:'跨期冲正',refund:'退款'};
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
    const isRefund=e.source==='refund';
    // 退回与冲正都不走支出撤销：退回走独立的“撤销退回”，冲正只读
    const canRev=e.status==='active'&&cat&&!isRefund&&e.source!=='reversal'&&e.periodKey===curKey;
    const canRevRefund=e.status==='active'&&cat&&isRefund&&e.periodKey===curKey;
    const src=budgetSourceLabel(e);
    const refundAmt=round4(Number(e.refundAmount)||0);
    // 历史账目按自身币种快照显示；缺失快照的旧账目固定读作 CNY，绝不回落到分类当前币种
    const ecur=historicalCurrencyOf(e);
    // 退回必须一眼看出是“退回”，不能显示成来源不明的 0 元支出
    const amountTxt=isRefund?('退回 +'+money(refundAmt,ecur)):(refundAmt?'冲正 +'+money(refundAmt,ecur):money(e.amount,ecur));
    let html='<div class="blog-row'+(e.status==='reversed'?' reversed':'')+(e.status==='compensated'?' compensated':'')+'">';
    html+='<div class="blog-main"><div class="blog-title">'+(cat?esc(cat.name):'已删除分类')+' · <b>'+amountTxt+'</b><span class="tag">'+esc(src)+'</span></div>';
    html+='<div class="blog-sub">'+fmtDate(e.ts)+' · '+budgetPeriodLabel(cat||{cycle:'week'},BudgetEngine.bounds((cat&&cat.cycle)||'week',e.ts))+(e.note?' · '+esc(e.note):'')+'</div>';
    if(e.topupAdded)html+='<div class="blog-sub">扩容 '+money(e.topupAdded,ecur)+'（花费 '+fmt(e.topupCost)+'）</div>';
    if(e.status==='compensated')html+='<div class="blog-sub">已于账期 '+(e.compensatedInPeriod||'')+' 冲正（历史周期与已发奖惩不变）</div>';
    const pen=(e.links.penaltyLogIds||[]).length,fed=(e.links.feedbackLogIds||[]).length;
    if(pen||fed)html+='<div class="blog-sub">'+(pen?'惩罚流水 '+pen+' 条':'')+(pen&&fed?' · ':'')+(fed?'反哺流水 '+fed+' 条':'')+'</div>';
    html+='</div>';
    html+='<div class="blog-act">';
    if(e.status==='reversed')html+='<span class="tag">已撤销</span>';
    else if(e.status==='compensated')html+='<span class="tag">已冲正</span>';
    else if(canRevRefund)html+='<button class="btn btn-sm" onclick="confirmReverseRefundEntry(\''+escAttr(e.id)+'\')">撤销退回</button>';
    else if(isRefund)html+='<span class="tag">跨期退回不可撤销</span>';
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
  // 多币种永不显示跨币种总额/总剩余：按币种分组平铺，顺序 = 分类创建顺序中首次出现的币种
  const groups=[];
  cats.forEach(function(c){
    const r=BudgetEngine.readPeriod(c,ts);
    const code=currencyOf(c);
    let g=groups.find(function(x){return x.code===code;});
    if(!g){g={code:code,limit:0,spent:0};groups.push(g);}
    g.limit+=Number(c.limit)||0;
    g.spent+=BudgetEngine.netSpentOf(r.period);
  });
  const per=document.getElementById('bPeriod');
  if(per)per.textContent=cats.length?groups.map(function(g){return money(g.spent,g.code)+' / '+money(g.limit,g.code);}).join(' · '):'—';
  const sub=document.getElementById('bPeriodSub');
  if(sub){
    const enabledCount=cats.filter(function(c){return c.enabled&&!c.archived;}).length;
    sub.textContent=enabledCount+' 个启用分类'+(groups.length>1?' · '+groups.length+' 种币种':'');
  }
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
  if(!confirm('撤销这笔现实账目？\n惩罚/反哺流水会一并退回；扩容在不会立刻制造超支时退回。'))return;
  // reverseEntry 不再自己落盘/渲染/提示，由这里按原有顺序收尾（save → render → toast）
  const r=BudgetEngine.reverseEntry(id);
  if(!r.ok){toast(r.reason||'撤销失败','err');return;}
  save();render();
  toast('已撤销预算账目');
}
// 撤回退走独立入口：只回退 p.refund，不触碰已花金额、结余奖励与已发奖惩
function confirmReverseRefundEntry(id){
  if(!confirm('撤销这笔退回？\n只回退本期退回金额；已花金额、结余奖励与已发奖惩都不受影响。'))return;
  const r=BudgetEngine.reverseRefund(id);
  if(!r.ok){toast(r.reason||'撤销退回失败','err');return;}
  // reverseRefund 的 txn 为 save:'none'，由这里统一收尾
  save();render();
  toast('已撤销退回');
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
    box.innerHTML='<div class="empty" style="padding:14px"><p style="color:var(--text-3);margin:0">还没有规则。加一条惩罚、结余奖励或反哺规则，它就会在记账时自动生效。</p></div>';
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
// 当前周期是否已有现实账目：有账目时禁止切换币种（否则本期金额会变成混合币种）
function budgetPeriodHasMoney(cat){
  if(!cat)return false;
  const p=BudgetEngine.readPeriod(cat,now()).period;
  return !!(p&&((Number(p.entryCount)||0)>0||(Number(p.spent)||0)>0||(Number(p.refund)||0)>0));
}
// 是否存在固定金额绑定（任务/项目/杂事/商品）；换币种后这些金额会按新币种解释
function hasFixedBudgetBinding(catId){
  function fixed(e){
    const b=e&&e.budget;
    return !!(b&&b.categoryId===catId&&b.mode!=='prompt'&&(Number(b.amount)||0)>0);
  }
  return (state.tasks||[]).some(fixed)||(state.affairs||[]).some(fixed)||(state.chores||[]).some(fixed)
    ||(state.products||[]).some(function(p){
      return !!(p&&p.budget&&p.budget.categoryId===catId&&(Number(p.budget.amount)||0)>0);
    });
}
function fillBudgetCurrencySelect(cat){
  const sel=document.getElementById('budgetCatCurrency');
  if(!sel)return;
  const val=cat?currencyOf(cat):'CNY';
  let opts=Object.keys(CURRENCIES).map(function(k){
    return '<option value="'+k+'">'+k+' '+CURRENCIES[k].symbol+'</option>';
  }).join('');
  // 分类里可能存着表外的合法代码：保留为选项，避免编辑一次就被静默改成 CNY
  if(!CURRENCIES[val])opts='<option value="'+escAttr(val)+'">'+esc(val)+'</option>'+opts;
  sel.innerHTML=opts;
  sel.value=val;
  const allowed=!budgetPeriodHasMoney(cat);
  sel.disabled=!allowed;
  const hint=document.getElementById('budgetCatCurrencyHint');
  if(hint)hint.textContent=allowed
    ?'换币种建议在周期边界上做，本期内更换会让该期的金额类条件失效。'
    :'本期已有账目，等本期结束后再改币种。';
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
  fillBudgetCurrencySelect(cat);
  document.getElementById('budgetCatEnabled').checked=cat?cat.enabled!==false:true;
  fillBudgetDomainSelect(cat?cat.defaultProgressDomainId:'');
  const od=(cat&&cat.overdraft)||{enabled:false,currency:'achievement',rate:2,maxCostPerPeriod:150};
  document.getElementById('budgetOdEnabled').checked=!!od.enabled;
  document.getElementById('budgetOdCurrency').value=od.currency||'achievement';
  document.getElementById('budgetOdRate').value=od.rate||2;
  document.getElementById('budgetOdMaxCost').value=od.maxCostPerPeriod!==undefined?od.maxCostPerPeriod:150;
  renderBudgetRuleList();
  openModal('budgetCatModal');
  markModalClean('budgetCatModal');
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
  const curSel=document.getElementById('budgetCatCurrency');
  const currency=curSel&&isCurrencyCode(curSel.value)?curSel.value:'CNY';
  const odEnabled=document.getElementById('budgetOdEnabled').checked;
  const odCurrency=document.getElementById('budgetOdCurrency').value==='vitality'?'vitality':'achievement';
  const odRate=Number(document.getElementById('budgetOdRate').value);
  const odMaxCost=Number(document.getElementById('budgetOdMaxCost').value);
  const errs=[];
  if(!name)errs.push({field:'budgetCatName',msg:'请填写分类名称'});
  if(!isFinite(limit)||limit<=0)errs.push({field:'budgetCatLimit',msg:'基础限额必须大于 0'});
  if(did&&!state.domains.some(function(d){return d.id===did;}))errs.push({field:'budgetCatDefaultDomain',msg:'默认领域不存在'});
  if(odEnabled&&(!isFinite(odRate)||odRate<=0))errs.push({field:'budgetOdRate',msg:'扩容汇率必须大于 0'});
  if(!isFinite(odMaxCost)||odMaxCost<0)errs.push({field:'budgetOdMaxCost',msg:'扩容花费上限不能为负'});
  if(errs.length){const first=rejectFields('budgetCatModal',errs);if(!first)toast(errs[0].msg,'err');return}
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
  // 币种变更守卫：本期已有账目直接拒绝（否则本期金额变成混合币种，金额类条件会 fail-closed）；
  // 本期为空但有固定金额绑定时二次确认（这些固定金额将按新币种解释）。
  const oldCurrency=old?currencyOf(old):'CNY';
  if(old&&oldCurrency!==currency){
    if(budgetPeriodHasMoney(old)){toast('本期已有账目，等本期结束后再改币种','err');return;}
    const warn='「'+old.name+'」有固定金额绑定，改币种后这些固定金额将按 '+currency+' 解释，是否继续？';
    if(hasFixedBudgetBinding(old.id)&&!confirm(warn))return;
    // 本期周期已存在但为空：顺手把周期快照更新为新币种；历史周期不回头改
    const rp=BudgetEngine.readPeriod(old,now());
    if(rp.period)rp.period.currency=currency;
  }
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
    cycle:cycle,anchor:anchor,limit:round4(limit),currency:currency,defaultProgressDomainId:did,
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
  runCommand({
    label:'del-budget-category',
    toast:'预算分类已删除',
    run:function(){
      const bd=state.ext.budgets;
      bd.categories=bd.categories.filter(function(c){return c.id!==id;});
      delete bd.current[id];
      delete bd.periods[id];
      bd.ledger=(bd.ledger||[]).filter(function(e){return e.categoryId!==id;});
      state.products.forEach(function(p){if(p.budget&&p.budget.categoryId===id)p.budget={categoryId:'',amount:0};});
    }
  });
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
    const code=currencyOf(c);
    return '<option value="'+escAttr(c.id)+'">'+esc(c.name)+(code!=='CNY'?'（'+esc(code)+'）':'')+'</option>';
  }).join('');
  const def=(catId&&cats.some(function(c){return c.id===catId;}))?catId:cats[0].id;
  sel.value=def;
  document.getElementById('qrAmount').value='';
  document.getElementById('qrNote').value='';
  // 每次打开默认回到“支出”，避免上一次的退回方向被无意识沿用
  const dirEl=document.getElementById('qrDirection');
  if(dirEl)dirEl.value='spend';
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
// 快速记账的金额标签跟随所选分类的币种
function qrCurrencyLabel(){
  const sel=document.getElementById('qrCategory');
  const lab=document.getElementById('qrCurrencyLabel');
  if(!lab)return;
  const cat=sel&&sel.value?BudgetEngine.category(sel.value):null;
  lab.textContent='（'+currencyOf(cat)+'）';
}
function qrDirection(){
  const el=document.getElementById('qrDirection');
  return el&&el.value==='refund'?'refund':'spend';
}
function renderQuickPreview(){
  const box=document.getElementById('qrPreview');
  const btn=document.getElementById('qrConfirmBtn');
  if(!box)return;
  qrCurrencyLabel();
  const catId=document.getElementById('qrCategory')?document.getElementById('qrCategory').value:'';
  const amount=parseFloat(document.getElementById('qrAmount').value);
  const dir=qrDirection();
  if(!catId||!isFinite(amount)||amount<=0){
    qrPreview=null;qrBasePlan=null;
    box.innerHTML='<div class="qr-hint">'+(dir==='refund'
      ?'输入金额后，这里会显示本期净花费与可退上限。退回不递减已花、不计入结余奖励。'
      :'输入金额后，这里会实时显示本期已花、是否超支、惩罚/反哺与扣后余额。预览是只读的。')+'</div>';
    if(btn)btn.disabled=true;
    return;
  }
  if(dir==='refund'){
    const plan=BudgetEngine.prepareRefund(catId,amount,now(),{});
    qrPreview=plan;qrBasePlan=null;
    box.innerHTML=refundPreviewHTML(plan);
    if(btn)btn.disabled=!plan.ok;
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
// 退回预览：只讲净花费、可退上限与退回后的净额，不显示惩罚/反哺/扩容
function refundPreviewHTML(plan){
  if(!plan||!plan.ok)return '<div class="qr-alert danger">'+esc((plan&&plan.reason)||'退回校验未通过')+'</div>';
  const cur=currencyOf(plan.cat);
  let html='<div class="qr-panel">';
  html+='<div class="qr-panel-head">'+esc(plan.cat.name)+' · 退回 · 本期 '+esc(budgetPeriodLabel(plan.cat,plan.bounds))+'</div>';
  html+='<div class="qr-line"><span>本期净花费</span><span>'+money(plan.netBefore,cur)+' → <b>'+money(plan.netAfter,cur)+'</b></span></div>';
  html+='<div class="qr-line"><span>本次退回</span><span class="pos">+'+money(plan.amount,cur)+'</span></div>';
  html+='<div class="qr-line"><span>可退上限</span><span>'+money(plan.netBefore,cur)+'</span></div>';
  html+='<div class="qr-hint">退回增加可用额度，但不递减已花金额、不计入结余奖励，也不返还已扣惩罚/反哺。已结算账期不能退回。</div>';
  html+='</div>';
  return html;
}
function budgetAccountRow(k,s){
  const b=s.balances&&s.balances[k];
  if(!b)return'';
  const delta=b.delta?(' <span class="'+(b.delta<0?'neg':'pos')+'">'+(b.delta>0?'+':'')+fmt(b.delta)+'</span>'):'';
  return '<div class="qr-bal"><span>'+BUDGET_TARGET_NAMES[k]+'</span><span>'+fmt(b.before)+' → <b class="'+(b.after<0?'neg':'')+'">'+fmt(b.after)+'</b>'+delta+'</span></div>';
}
function budgetPreviewHTML(plan,base){
  if(!plan||!plan.ok)return '<div class="qr-alert danger">'+esc((plan&&plan.reason)||'预览失败')+'</div>';
  const cur=currencyOf(plan.cat);
  let html='<div class="qr-panel">';
  html+='<div class="qr-panel-head">'+esc(plan.cat.name)+' · 本期 '+esc(budgetPeriodLabel(plan.cat,plan.bounds))+'</div>';
  html+='<div class="qr-line"><span>本期已花</span><span>'+money(plan.netBefore!==undefined?plan.netBefore:plan.spentBefore,cur)+' → <b>'+money(plan.netAfter!==undefined?plan.netAfter:plan.spentAfter,cur)+'</b></span></div>';
  if(plan.refund)html+='<div class="qr-line"><span>本期冲正</span><span>-'+money(plan.refund,cur)+'（不计入结余奖励）</span></div>';
  html+='<div class="qr-line"><span>有效额度</span><span>'+money(plan.limitAfter,cur)+(plan.topup.amount?'（含本次扩容 '+money(plan.topup.amount,cur)+'）':'')+'</span></div>';
  if(plan.overspendAfter)html+='<div class="qr-line danger"><span>本期超支</span><span>'+money(plan.overspendAfter,cur)+(plan.deltaOverspend?' · 本次新增 '+money(plan.deltaOverspend,cur):'')+'</span></div>';
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
    html+='本次记账会让本期超支 '+money(base.overspendAfter,cur)+'。';
    if(n.affordable){
      html+='可扩容 '+fmt(n.amount)+'（花 '+fmt(n.cost)+' '+BUDGET_TARGET_NAMES[n.currency]+'）'+
        '<label class="qr-topup"><input type="checkbox" '+(qrUseTopup?'checked':'')+' onchange="qrToggleTopup(this.checked)"> 扩容并记账</label>';
    }else{
      html+=esc(n.reason||'扩容额度或货币不足');
    }
    html+='</div>';
  }else if(base&&base.overspendAfter>0){
    html+='<div class="qr-alert danger">本次记账会让本期超支 '+money(base.overspendAfter,cur)+'，确认后将按规则结算惩罚。</div>';
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
  if(opts.direction==='refund'){
    const rr=Ledger.txn(function(tx){
      BudgetEngine.reconcileDue(catId,ts);
      plan=BudgetEngine.prepareRefund(catId,amount,ts,{note:note});
      if(!plan.ok){
        const err=new Error(plan.reason||plan.code);
        err.code=plan.code;err.info={reason:plan.reason,maxRefundable:plan.maxRefundable};
        throw err;
      }
      return BudgetEngine.commitRefund(tx,plan);
    },{label:'budget-refund',save:'none',render:false});
    if(!rr.ok){
      const info=(rr.error&&rr.error.info)||{};
      toast(info.reason||'退回失败','err');
      return{ok:false,error:rr.error};
    }
    // 退回走 save:'none' 的事务，这里统一收尾
    save();render();
    toast('已退回「'+plan.cat.name+'」+'+money(plan.amount,currencyOf(plan.cat)));
    return{ok:true,plan:plan,result:rr.value};
  }
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
  let msg='已记「'+plan.cat.name+'」'+money(plan.amount,currencyOf(plan.cat));
  (plan.effects||[]).forEach(function(e){msg+=' · '+e.desc});
  if(plan.topup.amount)msg+=' · 扩容 '+fmt(plan.topup.amount)+'（-'+fmt(plan.topup.cost)+' '+BUDGET_TARGET_NAMES[plan.topup.currency]+'）';
  // 记账事务同样以 save:'none' 执行，这里统一收尾
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
  const res=quickRecordBudget(catId,amount,note,now(),{topup:topup,direction:qrDirection()});
  if(res.ok){
    closeModal('quickRecordModal');
    qrUseTopup=false;
    qrPreview=null;
    qrBasePlan=null;
  }
}

export { budEditingId, budDraftRules, budCondEditIdx, qrPreview, qrBasePlan, qrUseTopup, budgetPeriodLabel, budgetCatCardHTML, budgetLedgerHTML, renderBudget, confirmReverseBudgetEntry, confirmReverseRefundEntry, fillBudgetDomainSelect, budgetRuleDefault, budgetWhenSummary, budgetCondPreview, budgetRuleCardHTML, kindBaseHint, renderBudgetRuleList, budgetUpdateWhenSummary, collectBudgetRulesFromDOM, budRuleAdd, budRuleDelete, budRuleMove, budRuleKindChanged, budRuleAccountChanged, budRuleModeChanged, budRuleEditWhen, budRuleDoneWhen, budCondModeChange, openBudgetCatModal, syncBudgetAnchorVisibility, dismissBudgetAnchorNotice, saveBudgetCategory, confirmDelBudgetCategory, openQuickRecordModal, qrToggleTopup, renderQuickPreview, budgetAccountRow, budgetPreviewHTML, quickRecordBudget, qrConfirm };

registerRenderer('budget', renderBudget);
