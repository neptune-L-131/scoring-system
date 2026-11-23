import { registerRenderer } from './render.js';
import { BudgetEngine } from './budget.js';
import { PROD_TIER_NAMES } from './constants.js';
import { tierCurrency } from './defaults.js';
import { evaluateProductGate, validProductTier } from './gate.js';
import { buyProduct, delShopCategory, renameShopCategory } from './library.js';
import { execBoughtCount } from './exec-quota.js';
import { confirmDelProd, openProdModal } from './modals.js';
import { save } from './persist.js';
import { esc, fmt, fmtTime, now, currencyOf, money } from './pure.js';
import { setScoreCell } from './render-work.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { toggleCollapse } from './ui-events.js';
import { undoLog } from './undo.js';
import { actionsRowHTML, collBodyHTML, collGroupHTML, collHeaderHTML, dragHandleHTML, logItemHTML } from './view-primitives.js';
// render-shop.js —— 渲染：商店页
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Render: Shop =====
function renderShop(){
  setScoreCell('sVitality',state.scores.vitality);
  setScoreCell('sAchievement',state.scores.achievement);

  const sl=document.getElementById('shopList');
  let html='';
  state.shopCategories.forEach(cat=>{
    // Filter out sold-out products (stock===0) — they go to the sold-out section
    const prods=state.products.filter(p=>(p.categoryId||'sc_default')===cat.id&&p.stock!==0);
    const isCollapsed=(state.collapsedShopCats||[]).includes(cat.id);
    let actions=dragHandleHTML('拖拽分类');
    actions+='<button onclick="openProdModal(null,\''+cat.id+'\')">+ 商品</button>';
    if(cat.id!=='sc_default'){
      actions+='<button onclick="renameShopCategory(\''+cat.id+'\')">重命名</button><button onclick="delShopCategory(\''+cat.id+'\')">删除</button>';
    }
    const body=prods.length===0
      ?'<div class="empty" style="padding:16px"><p style="margin:0;color:var(--text-3)">暂无商品 · 拖拽 ⋮⋮ 按钮可排序或跨分类移动</p></div>'
      :'<div class="shop-grid">'+prods.map(p=>shopCardHTML(p,cat.id)).join('')+'</div>';
    html+=collGroupHTML('shop-cat-group','data-cat-id="'+cat.id+'"',isCollapsed,
      collHeaderHTML({onclick:"toggleCollapse('shop-category','"+cat.id+"')",name:esc(cat.name),count:prods.length,countLabel:'件',actions:actions})
      +collBodyHTML(body));
  });

  // Sold-out section
  const soldoutProds=state.products.filter(p=>p.stock===0);
  if(soldoutProds.length>0){
    const isSoldCollapsed=(state.collapsedShopCats||[]).includes('sc_soldout');
    let sbody='';

    // Group sold-out products by their original categoryId
    const soldByCat={};
    soldoutProds.forEach(function(p){
      const catId=p.categoryId||'sc_default';
      if(!soldByCat[catId])soldByCat[catId]=[];
      soldByCat[catId].push(p);
    });

    // Render each sub-group
    Object.keys(soldByCat).forEach(function(catId){
      const cat=state.shopCategories.find(function(c){return c.id===catId;});
      const catName=cat?cat.name:'默认';
      const prods=soldByCat[catId];

      // Build category options for the dropdown
      const catOptions=state.shopCategories.map(function(c){
        return '<option value="'+c.id+'"'+(c.id===catId?' selected':'')+'>'+esc(c.name)+'</option>';
      }).join('');

      sbody+='<div class="soldout-sub" data-prev-cat-id="'+catId+'">';
      sbody+='<div class="soldout-sub-header">';
      sbody+='<div class="ss-name">'+dragHandleHTML('拖拽排序')+esc(catName)+'</div>';
      sbody+='<select onchange="changeSoldoutCat(this,\''+catId+'\')">'+catOptions+'</select>';
      sbody+='</div>';
      sbody+='<div class="shop-grid">'+prods.map(function(p){return shopCardHTML(p,'sc_soldout',catId);}).join('')+'</div>';
      sbody+='</div>';
    });

    html+=collGroupHTML('shop-cat-group','data-cat-id="sc_soldout"',isSoldCollapsed,
      collHeaderHTML({onclick:"toggleCollapse('shop-category','sc_soldout')",name:'售罄',count:soldoutProds.length,countLabel:'件',actions:''})
      +collBodyHTML(sbody));
  }

  sl.innerHTML=html;

  const pl=document.getElementById('purchaseList');
  const purchases=state.logs.filter(l=>l.src==='purchase'&&l.primaryPurchase!==false);
  if(!purchases.length){
    pl.innerHTML='<div class="empty" style="padding:24px"><p style="margin:0">暂无购买记录</p></div>';
  }else{
    pl.innerHTML=purchases.slice(0,50).map(l=>{
      const dotCls=l.st==='vitality'?'v':'a';
      return logItemHTML({dot:dotCls,desc:esc(l.desc),amtCls:'neg',amt:fmt(l.amt),time:fmtTime(l.time),
        action:'<button class="log-undo" onclick="undoLog(\''+l.id+'\')">撤销</button>'});
    }).join('');
  }
}

// Product card HTML helper
function shopCardHTML(p,catId,prevCatId){
  const tier=validProductTier(p.tier);
  const cur=tierCurrency(tier);
  const isV=cur==='vitality';
  const cn=isV?'活力点':'成果点';
  const balance=state.scores[cur];
  const assetPrice=(p.assetPrice&&p.assetPrice.assetId)?p.assetPrice:null;
  const assetDef=assetPrice?(state.assetDefs||[]).find(function(d){return d&&d.id===assetPrice.assetId;})||null:null;
  const assetBal=assetPrice?((state.cards&&state.cards[assetPrice.assetId])||0):0;
  const assetLack=!!assetPrice&&assetBal<assetPrice.amount;
  const assetTxt=assetPrice?' · 另需'+assetPrice.amount+' '+(assetDef?assetDef.name:assetPrice.assetId):'';
  const grantTxt=(p.grants||[]).map(function(g){
    if(g.kind==='asset'){
      const d=(state.assetDefs||[]).find(function(x){return x&&x.id===g.assetId;});
      return '赠'+(d?d.name:g.assetId)+'×'+g.amount;
    }
    return '赠'+(g.account==='vitality'?'活力点':'成果点')+' '+fmt(g.amount);
  }).join('、');
  // 执行权：买一次 = 指定动作流执行一次；显示周期额度与剩余次数
  const exec=(p.exec&&p.exec.flowId)?p.exec:null;
  const execFlow=exec?((state.flows||[]).find(function(f){return f&&f.id===exec.flowId;})||null):null;
  let execTxt='';
  let execUsed=0;
  if(exec){
    const per=exec.period==='day'?'天':exec.period==='month'?'月':'周';
    const lim=Number(exec.maxPerPeriod)||1;
    execUsed=execBoughtCount(state.ext&&state.ext.execBuys,p.id,exec,now());
    execTxt='买一次：执行「'+(execFlow?execFlow.name:'已删除的动作流')+'」一次 · 每'+per+'限'+lim+'次（本期 '+execUsed+'/'+lim+'）';
  }
  const execBad=!!exec&&(!execFlow||execFlow.enabled===false||execFlow.invalid||execUsed>=(Number(exec.maxPerPeriod)||1));
  const willLoan=!assetPrice&&balance<p.price;
  const isSoldout=p.stock===0;
  const gate=evaluateProductGate(p);
  const locked=gate.deny&&!isSoldout;
  const stockTxt=p.stock===-1?'':p.stock===0?' · 售罄':' · 库存'+p.stock;
  const debtTxt=(!assetPrice&&(p.debtRate||0)>0)?' · 债率'+fmt(p.debtRate)+'%/天':'';
  const loanWarn=willLoan&&!isSoldout&&!gate.deny?' · 贷款'+fmt(p.price-balance):'';
  const soldoutCls=isSoldout?' soldout':'';
  const lockedCls=locked?' locked':'';
  // 商品现实预算行按所属分类的币种显示；分类已删除时不显示币种符号
  const budCat=(p.budget&&p.budget.categoryId)?BudgetEngine.category(p.budget.categoryId):null;
  const budTxt=(p.budget&&p.budget.categoryId&&Number(p.budget.amount)>0)
    ?'<div class="sh-budget">预算·'+esc(budCat?budCat.name:'已删除分类')+' '+(budCat?money(p.budget.amount,currencyOf(budCat)):'?'+fmt(p.budget.amount))+'</div>':'';
  const dataPrevCat=prevCatId?' data-prev-cat-id="'+prevCatId+'"':'';
  const tierTxt=' · '+(PROD_TIER_NAMES[tier]||PROD_TIER_NAMES.daily);
  const gateHTML=gate.deny?'<div class="sh-gate">'+gate.reasons.map(function(r){return '<div>'+esc(r)+'</div>';}).join('')+'</div>':'';
  const buyHTML=isSoldout
    ?'<div class="sh-buy" style="text-align:center;font-size:12px;color:var(--text-3);padding:8px">售罄</div>'
    :gate.deny
      ?'<button class="btn btn-sm sh-buy" disabled>门槛未达标</button>'
      :assetLack
        ?'<button class="btn btn-sm sh-buy" disabled>资产不足</button>'
        :execBad
          ?'<button class="btn btn-sm sh-buy" disabled>'+(execUsed>=exec.maxPerPeriod?'本周期次数已用完':'动作流不可用')+'</button>'
          :'<button class="btn btn-sm sh-buy" onclick="buyProduct(\''+p.id+'\')">'+(willLoan?'贷款购买':'购买')+'</button>';
  return '<div class="shop-card'+soldoutCls+lockedCls+'" data-prod-id="'+p.id+'" data-cat-id="'+catId+'"'+dataPrevCat+'>'
    +'<div class="card-top" style="margin-bottom:0"><div class="sh-name">'+esc(p.name)+'</div>'
    +actionsRowHTML('card-actions',dragHandleHTML('拖拽排序或跨分类移动')+'<button onclick="openProdModal(\''+p.id+'\')">编辑</button><button class="del" onclick="confirmDelProd(\''+p.id+'\')">删除</button>')+'</div>'
    +(p.desc?'<div class="sh-desc">'+esc(p.desc)+'</div>':'')
    +budTxt
    +(grantTxt?'<div class="sh-budget">'+esc(grantTxt)+'</div>':'')
    +(execTxt?'<div class="sh-budget">'+esc(execTxt)+'</div>':'')
    +'<div class="sh-cost '+(isV?'v':'a')+'">'+fmt(p.price)+'<span class="unit">'+cn+tierTxt+stockTxt+debtTxt+loanWarn+assetTxt+'</span></div>'
    +gateHTML
    +buyHTML
    +'</div>';
}

// Change sold-out product's original category (sub-grouping)
function changeSoldoutCat(sel,oldCatId){
  const newCatId=sel.value;
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

export { renderShop, shopCardHTML, changeSoldoutCat };

registerRenderer('shop', renderShop);
