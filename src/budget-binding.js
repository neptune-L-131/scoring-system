import { BudgetEngine } from './budget.js';
import { closeModal, openModal } from './modal-host.js';
import { esc, fmt, now, round4 } from './pure.js';
import { state } from './state.js';
import { toast } from './toast.js';
// budget-binding.js —— 事项（任务/项目/杂事）× 现实预算的绑定、执行与联动撤销
// 设计要点：
// 1) 绑定挂在实体上（budget 字段），不建旁表：生命周期随实体、渲染零 join、老存档只补 null。
// 2) 事务同步：金额弹窗永远在 Ledger.txn 之前完成，事务体内不再有异步。
// 3) 撤销双向链接：账目侧 links.* 供查询，源侧 budgetRef 供 O(1) 定位且不怕账本裁剪。
// 4) 跨期不硬撤：当期 reverseEntry，跨期走 compensateEntry（历史冻结，本期只记退回额度）。

const budgetDrafts=new Map();
let amountDialog=null;

function budgetFail(code,reason){
  const e=new Error(code);e.__txn=true;e.code=code;e.info={reason:reason||'预算操作失败'};return e;
}
function draftKey(kind,id){return String(kind)+':'+String(id);}

// ===== 形状守卫 =====
export function normalizeBudgetBinding(b,ctx){
  if(!b||typeof b!=='object')return null;
  const categoryId=String(b.categoryId==null?'':b.categoryId);
  if(!categoryId)return null;
  const mode=b.mode==='prompt'?'prompt':'fixed';
  const amount=Math.max(0,Math.round((Number(b.amount)||0)*1e4)/1e4);
  const lastAmount=Math.max(0,Math.round((Number(b.lastAmount)||0)*1e4)/1e4);
  const catIds=ctx&&ctx.catIds;
  const stale=catIds?(!catIds.has(categoryId)):!!b.stale;
  return{categoryId:categoryId,mode:mode,amount:amount,lastAmount:lastAmount,stale:stale};
}
export function normalizeBudgetRef(ref){
  if(!ref||typeof ref!=='object')return null;
  const entryId=String(ref.entryId==null?'':ref.entryId);
  const catId=String(ref.catId==null?'':ref.catId);
  if(!entryId&&!catId)return null;
  return{
    entryId:entryId,catId:catId,
    amount:Math.max(0,Math.round((Number(ref.amount)||0)*1e4)/1e4),
    periodKey:String(ref.periodKey==null?'':ref.periodKey)
  };
}
export function budgetOf(entity){
  if(!entity||!entity.budget||typeof entity.budget!=='object')return null;
  const categoryId=String(entity.budget.categoryId||'');
  if(!categoryId)return null;
  return{
    categoryId:categoryId,
    mode:entity.budget.mode==='prompt'?'prompt':'fixed',
    amount:round4(Number(entity.budget.amount)||0),
    lastAmount:round4(Number(entity.budget.lastAmount)||0),
    stale:!!entity.budget.stale
  };
}
export function needsAmountPrompt(entity){
  const b=budgetOf(entity);
  return !!(b&&b.mode==='prompt');
}

// ===== 执行前解析：只读；失败降级为“不记账”，绝不阻断事项本身 =====
export function resolveActionBudget(entity,opts){
  opts=opts||{};
  const bind=budgetOf(entity);
  if(!bind)return{status:'none'};
  const cat=BudgetEngine.category(bind.categoryId);
  if(!cat)return{status:'skip',reason:'预算分类已删除，本次未记现实账'};
  if(cat.archived)return{status:'skip',reason:'预算分类已归档，本次未记现实账'};
  if(cat.enabled===false)return{status:'skip',reason:'预算分类已停用，本次未记现实账'};
  let amount=opts.amount;
  if(amount===undefined||amount===null){
    amount=bind.mode==='prompt'
      ?(budgetDrafts.has(draftKey(opts.kind,opts.id))?budgetDrafts.get(draftKey(opts.kind,opts.id)):bind.lastAmount)
      :bind.amount;
  }
  amount=round4(Math.max(0,Number(amount)||0));
  if(!(amount>0))return{status:'skip',reason:'预算金额无效，本次未记现实账'};
  const pv=BudgetEngine.preview(bind.categoryId,amount,opts.ts||now());
  if(!pv.ok)return{status:'skip',reason:(pv.reason||'预算校验未通过')+'，本次未记现实账'};
  let plan=null;
  try{
    plan=BudgetEngine.prepareEntry(bind.categoryId,amount,{
      ts:opts.ts||now(),source:opts.source,allowNegative:true
    });
  }catch(err){
    return{status:'skip',reason:'预算记账失败，本次未记现实账'};
  }
  return{status:'ok',plan:plan,bind:bind,cat:cat,amount:amount};
}
export function markActionBudgetDone(kind,id,amount){
  budgetDrafts['delete'](draftKey(kind,id));
  const entity=findEntity(kind,id);
  if(!entity||!entity.budget)return;
  if(entity.budget.mode==='prompt')entity.budget.lastAmount=round4(Math.max(0,Number(amount)||0));
}
function findEntity(kind,id){
  if(kind==='task')return (state.tasks||[]).find(function(x){return x.id===id;})||null;
  if(kind==='affair')return (state.affairs||[]).find(function(x){return x.id===id;})||null;
  if(kind==='chore')return (state.chores||[]).find(function(x){return x.id===id;})||null;
  return null;
}
export function budgetRefOf(entry,plan,extra){
  if(!entry)return null;
  return{
    entryId:entry.id,catId:plan.catId,
    amount:round4(Number(plan.amount)||0),periodKey:String(plan.periodKey||entry.periodKey||'')
  };
}

// ===== 撤销联动：当期硬撤 / 跨期冲正；已撤销视为幂等成功 =====
export function reverseBoundBudget(ref){
  const r=normalizeBudgetRef(ref);
  if(!r)return{ok:true,mode:'noop'};
  const cat=BudgetEngine.category(r.catId);
  if(!cat)return{ok:true,mode:'noop'};
  const bd=state.ext&&state.ext.budgets;
  const entry=(bd&&Array.isArray(bd.ledger)&&r.entryId)
    ?bd.ledger.find(function(e){return e.id===r.entryId;})||null:null;
  if(entry&&entry.status&&entry.status!=='active')return{ok:true,mode:'noop'};
  const rp=BudgetEngine.readPeriod(cat,now());
  const curKey=(rp&&rp.b&&rp.b.key)||'';
  const samePeriod=!!(entry&&curKey&&entry.periodKey===curKey&&rp.period&&rp.period.end>now());
  if(samePeriod){
    const ok=BudgetEngine.reverseEntry(entry.id);
    if(!ok)throw budgetFail('BUDGET_REVERSE_FAILED','撤销现实账目失败');
    return{ok:true,mode:'reverse'};
  }
  const ok=BudgetEngine.compensateEntry({
    entryId:r.entryId,catId:cat.id,amount:r.amount,periodKey:r.periodKey
  });
  if(!ok)throw budgetFail('BUDGET_COMPENSATE_FAILED','跨期冲正现实账目失败');
  return{ok:true,mode:'compensate'};
}

// ===== 编辑弹窗里的绑定组 =====
export function budgetBindingHTML(prefix,entity){
  const bind=budgetOf(entity);
  const cats=BudgetEngine.categories();
  let opts='<option value="">不绑定</option>';
  cats.forEach(function(c){
    const label=esc(c.name)+(c.archived?'（已归档）':(c.enabled===false?'（已停用）':''));
    opts+='<option value="'+esc(c.id)+'"'+(bind&&bind.categoryId===c.id?' selected':'')+'>'+label+'</option>';
  });
  if(bind&&bind.stale&&!cats.some(function(c){return c.id===bind.categoryId;})){
    opts+='<option value="'+esc(bind.categoryId)+'" selected>已删除的分类</option>';
  }
  const mode=bind?bind.mode:'fixed';
  return '<div class="fg budget-bind">'
    +'<label>现实预算 <span class="h">绑定后，打卡 / 项目推进 / 杂事勾选会自动记一笔现实账</span></label>'
    +'<div class="bud-row">'
    +'<select id="'+prefix+'BudCat" onchange="budgetBindingModeChange(\''+prefix+'\')">'+opts+'</select>'
    +'<select id="'+prefix+'BudMode" onchange="budgetBindingModeChange(\''+prefix+'\')">'
    +'<option value="fixed"'+(mode==='fixed'?' selected':'')+'>固定金额</option>'
    +'<option value="prompt"'+(mode==='prompt'?' selected':'')+'>每次输入</option>'
    +'</select>'
    +'<input type="number" id="'+prefix+'BudAmount" min="0" step="0.01" placeholder="金额" value="'
    +(bind&&bind.amount?bind.amount:'')+'"'+(mode==='prompt'?' disabled':'')+'>'
    +'</div>'
    +'<input type="hidden" id="'+prefix+'BudLast" value="'+(bind&&bind.lastAmount?bind.lastAmount:'')+'">'
    +'<div class="bud-hint" id="'+prefix+'BudHint">'+bindingHint(bind)+'</div>'
    +'</div>';
}
function bindingHint(bind){
  if(!bind)return '未绑定：执行事项不会产生现实账目。';
  if(bind.stale)return '绑定的预算分类已失效：执行时不会记账，请重新选择。';
  if(bind.mode==='prompt')return '每次执行时弹窗输入金额；取消则整个动作不执行。';
  return '每次执行按固定金额 '+fmt(bind.amount)+' 记一笔现实账。';
}
export function budgetBindingModeChange(prefix){
  const cat=document.getElementById(prefix+'BudCat');
  const mode=document.getElementById(prefix+'BudMode');
  const amt=document.getElementById(prefix+'BudAmount');
  const hint=document.getElementById(prefix+'BudHint');
  if(amt)amt.disabled=!!(mode&&mode.value==='prompt')||!(cat&&cat.value);
  if(hint){
    if(!cat||!cat.value)hint.textContent='未绑定：执行事项不会产生现实账目。';
    else if(mode&&mode.value==='prompt')hint.textContent='每次执行时弹窗输入金额；取消则整个动作不执行。';
    else hint.textContent='每次执行按固定金额记一笔现实账。';
  }
}
export function readBudgetBinding(prefix){
  const cat=document.getElementById(prefix+'BudCat');
  const mode=document.getElementById(prefix+'BudMode');
  const amt=document.getElementById(prefix+'BudAmount');
  const last=document.getElementById(prefix+'BudLast');
  const categoryId=cat?String(cat.value||''):'';
  if(!categoryId)return null;
  return{
    categoryId:categoryId,
    mode:(mode&&mode.value==='prompt')?'prompt':'fixed',
    amount:round4(Math.max(0,Number(amt&&amt.value)||0)),
    lastAmount:round4(Math.max(0,Number(last&&last.value)||0)),
    stale:false
  };
}
export function budgetBadgeHTML(entity){
  const b=budgetOf(entity);
  if(!b)return '';
  const cat=BudgetEngine.category(b.categoryId);
  const name=cat?cat.name:'预算分类已失效';
  const stale=!cat||b.stale||!!cat.archived||cat.enabled===false;
  const amt=b.mode==='prompt'?'待填':('¥'+fmt(b.amount));
  return '<span class="bud-badge'+(stale?' stale':'')+'" title="现实预算">'+amt+' · '+esc(name)+'</span>';
}

// ===== 金额弹窗（事务之前完成）=====
export function openBudgetAmountDialog(opts){
  if(amountDialog){
    // Esc / 点遮罩会绕过 cancel 直接关掉弹窗：这里按“弹窗已不可见”视为已取消，
    // 否则残留的 amountDialog 会让后续所有金额输入被永久拒绝。
    const bg=document.getElementById('budgetAmountModal');
    if(bg&&!bg.classList.contains('show'))amountDialog=null;
    else{toast('请先完成当前金额输入','warn');return;}
  }
  const bind=budgetOf(opts.entity);
  if(!bind)return;
  const cat=BudgetEngine.category(bind.categoryId);
  amountDialog=opts;
  const title=document.getElementById('budgetAmountTitle');
  const catEl=document.getElementById('budgetAmountCat');
  const input=document.getElementById('budgetAmountInput');
  const hint=document.getElementById('budgetAmountHint');
  if(title)title.textContent=opts.title||'记录现实花费';
  if(catEl)catEl.textContent=cat?cat.name:'';
  const draft=budgetDrafts.has(draftKey(opts.kind,opts.id))?budgetDrafts.get(draftKey(opts.kind,opts.id)):bind.lastAmount;
  if(input)input.value=draft>0?draft:'';
  if(hint)hint.textContent='取消则本次动作不执行；金额只在确认后写入。';
  renderAmountPreview();
  openModal('budgetAmountModal');
  if(input)setTimeout(function(){input.focus();input.select();},40);
}
export function budgetAmountInput(){renderAmountPreview();}
function renderAmountPreview(){
  const box=document.getElementById('budgetAmountPreview');
  if(!box||!amountDialog)return;
  const v=round4(Number(document.getElementById('budgetAmountInput').value)||0);
  if(!(v>0)){box.innerHTML='<span class="dim">输入金额后显示本期预算与惩罚预估</span>';return;}
  const pv=BudgetEngine.preview(amountDialog.entity.budget.categoryId,v,now());
  if(!pv.ok){box.innerHTML='<span class="neg">'+esc(pv.reason||'预算校验未通过')+'</span>';return;}
  let html='本期已花 <b>'+fmt(pv.netBefore)+'</b> / 限额 <b>'+fmt(pv.limitAfter)+'</b>'
    +' · 本笔后 <b>'+fmt(pv.netAfter)+'</b>';
  const pen=pv.effects.filter(function(e){return e.kind==='penalty';});
  if(pen.length)html+=' · 预计惩罚 <b class="neg">'+pen.map(function(e){return fmt(e.amount);}).join(' + ')+'</b>';
  const fb=pv.effects.filter(function(e){return e.kind==='feedback';});
  if(fb.length)html+=' · 反哺 <b class="pos">'+fb.map(function(e){return fmt(e.amount);}).join(' + ')+'</b>';
  if(pv.insufficient)html+=' · <span class="neg">虚拟余额将转负</span>';
  box.innerHTML=html;
}
export function budgetAmountConfirm(){
  const dlg=amountDialog;
  const input=document.getElementById('budgetAmountInput');
  if(!dlg||!input)return;
  const raw=String(input.value).trim();
  const v=Number(raw);
  if(raw===''||!isFinite(v)||v<=0){toast('请输入大于 0 的金额','err');return;}
  if(v>99999){toast('金额过大','err');return;}
  const amount=round4(v);
  const kind=dlg.kind,id=dlg.id;
  amountDialog=null;
  budgetDrafts.set(draftKey(kind,id),amount);
  closeModal('budgetAmountModal');
  const fn=dlg.onConfirm;
  if(typeof fn==='function')fn(amount);
}
export function budgetAmountCancel(){
  const dlg=amountDialog;
  amountDialog=null;
  closeModal('budgetAmountModal');
  if(dlg&&typeof dlg.onCancel==='function')dlg.onCancel();
}
// 事务回滚后保留用户输入（草稿在 state 之外，不参与回滚）
export function rememberBudgetDraft(kind,id,amount){budgetDrafts.set(draftKey(kind,id),round4(Math.max(0,Number(amount)||0)));}
