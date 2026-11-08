import { registerRenderer } from './render.js';
import { BudgetEngine } from './budget.js';
import { PROD_TIER_NAMES } from './constants.js';
import { tierCurrency } from './defaults.js';
import { evaluateProductGate, validProductTier } from './gate.js';
import { buyProduct, delShopCategory, renameShopCategory } from './library.js';
import { confirmDelProd, openProdModal } from './modals.js';
import { save } from './persist.js';
import { esc, fmt, fmtTime } from './pure.js';
import { setScoreCell } from './render-work.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
import { drag, toggleCollapse } from './ui-events.js';
import { undoLog } from './undo.js';
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
  const soldoutProds=state.products.filter(p=>p.stock===0);
  if(soldoutProds.length>0){
    const isSoldCollapsed=(state.collapsedShopCats||[]).includes('sc_soldout');
    html+='<div class="shop-cat-group'+(isSoldCollapsed?' collapsed':'')+'" data-cat-id="sc_soldout">';
    html+='<div class="coll-header" onclick="toggleCollapse(\'shop-category\',\'sc_soldout\')">';
    html+='<div class="coll-name"><span class="coll-toggle">▼</span>售罄 <span class="coll-count">'+soldoutProds.length+'件</span></div>';
    html+='<div class="coll-actions" onclick="event.stopPropagation()">';
    html+='</div>';
    html+='</div>';
    html+='<div class="coll-body">';

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
  const tier=validProductTier(p.tier);
  const cur=tierCurrency(tier);
  const isV=cur==='vitality';
  const cn=isV?'活力点':'成果点';
  const balance=state.scores[cur];
  const willLoan=balance<p.price;
  const isSoldout=p.stock===0;
  const gate=evaluateProductGate(p);
  const locked=gate.deny&&!isSoldout;
  const stockTxt=p.stock===-1?'':p.stock===0?' · 售罄':' · 库存'+p.stock;
  const debtTxt=(p.debtRate||0)>0?' · 债率'+fmt(p.debtRate)+'%/天':'';
  const loanWarn=willLoan&&!isSoldout&&!gate.deny?' · 贷款'+fmt(p.price-balance):'';
  const soldoutCls=isSoldout?' soldout':'';
  const lockedCls=locked?' locked':'';
  const dataPrevCat=prevCatId?' data-prev-cat-id="'+prevCatId+'"':'';
  const tierTxt=' · '+(PROD_TIER_NAMES[tier]||PROD_TIER_NAMES.daily);
  const gateHTML=gate.deny?'<div class="sh-gate">'+gate.reasons.map(function(r){return '<div>'+esc(r)+'</div>';}).join('')+'</div>':'';
  const buyHTML=isSoldout
    ?'<div class="sh-buy" style="text-align:center;font-size:12px;color:var(--text-3);padding:8px">售罄</div>'
    :gate.deny
      ?'<button class="btn btn-sm sh-buy" disabled>门槛未达标</button>'
      :'<button class="btn btn-sm sh-buy" onclick="buyProduct(\''+p.id+'\')">'+(willLoan?'贷款购买':'购买')+'</button>';
  return '<div class="shop-card'+soldoutCls+lockedCls+'" data-prod-id="'+p.id+'" data-cat-id="'+catId+'"'+dataPrevCat+'>'
    +'<div class="card-top" style="margin-bottom:0"><div class="sh-name">'+esc(p.name)+'</div>'
    +'<div class="card-actions"><span class="drag-handle" title="拖拽排序或跨分类移动">⋮⋮</span><button onclick="openProdModal(\''+p.id+'\')">编辑</button><button class="del" onclick="confirmDelProd(\''+p.id+'\')">删除</button></div></div>'
    +(p.desc?'<div class="sh-desc">'+esc(p.desc)+'</div>':'')
    +((p.budget&&p.budget.categoryId&&Number(p.budget.amount)>0)
      ?'<div class="sh-budget">预算·'+esc((BudgetEngine.category(p.budget.categoryId)||{name:'已删除分类'}).name)+' '+fmt(p.budget.amount)+'</div>':'')
    +'<div class="sh-cost '+(isV?'v':'a')+'">'+fmt(p.price)+'<span class="unit">'+cn+tierTxt+stockTxt+debtTxt+loanWarn+'</span></div>'
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
