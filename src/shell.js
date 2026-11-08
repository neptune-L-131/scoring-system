import { render } from './render.js';
import { BudgetEngine } from './budget.js';
import { save } from './persist.js';
import { esc } from './pure.js';
import { renderBudget } from './render-budget.js';
import { state } from './state.js';
// shell.js —— 页面骨架：Tab 切换、下拉助手、Toast、renderAll
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Tab =====
function goTab(name){
  // 打开预算页是惰性结算触发点之一：先把已结束周期结清再展示
  if(name==='budget'&&BudgetEngine.reconcileAll())save();
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));
  if(name==='budget')renderBudget();
}

// ===== Helpers for selects =====
function fillSelect(sel,items,selected){
  if(!sel)return;
  sel.innerHTML=items.map(function(x){
    return '<option value="'+x.id+'"'+(x.id===selected?' selected':'')+'>'+esc(x.name)+'</option>';
  }).join('');
}
function fillCollectionSelect(sel,selected){fillSelect(sel,state.collections,selected);}
function fillDomainSelect(sel,selected){fillSelect(sel,state.domains,selected);}
// Multi-select domain checklist for task modal
function fillDomainChecklist(container, selectedIds){
  const selSet=new Set(selectedIds);
  container.innerHTML=state.domains.map(d=>{
    const isSel=selSet.has(d.id);
    return '<label class="dom-check'+(isSel?' sel':'')+'" data-dom-id="'+d.id+'">'
      +'<input type="checkbox" value="'+d.id+'" '+(isSel?'checked':'')+'>'
      +'<span>'+esc(d.name)+'</span></label>';
  }).join('');
  // 事件委托（容器只绑一次）：整行点击切换勾选，勾选框自身变化同步高亮
  if(container._domCheckBound)return;
  container._domCheckBound=true;
  container.addEventListener('click',function(e){
    const lbl=e.target.closest('.dom-check');
    if(!lbl||!container.contains(lbl))return;
    if(e.target.tagName==='INPUT')return; // 勾选框本体交给原生 + change 处理
    // 阻断 label 的原生激活，避免「原生切换 + 手动反转」造成点一次翻两次
    e.preventDefault();
    const cb=lbl.querySelector('input');
    if(!cb)return;
    cb.checked=!cb.checked;
    lbl.classList.toggle('sel',cb.checked);
  });
  container.addEventListener('change',function(e){
    if(!e.target||e.target.tagName!=='INPUT')return;
    const lbl=e.target.closest('.dom-check');
    if(lbl)lbl.classList.toggle('sel',e.target.checked);
  });
}
function getCheckedDomainIds(){
  const ids=[];
  document.querySelectorAll('#taskDomainList .dom-check input:checked').forEach(cb=>ids.push(cb.value));
  return ids.length>0?ids:['d_default'];
}

// ===== Render All =====

// ===== Toast =====
export { goTab, fillSelect, fillCollectionSelect, fillDomainSelect, fillDomainChecklist, getCheckedDomainIds };
