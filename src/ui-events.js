import { Persist, save } from './persist.js';
import { renderBank } from './render-bank.js';
import { renderWork } from './render-work.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
// ui-events.js —— 内联开关、折叠、拖拽排序
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

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

// ===== Major section collapse (事务/任务/档案馆) =====
function toggleMajor(key){
  const arr=state.majorCollapsed||[];
  const i=arr.indexOf(key);
  if(i>=0)arr.splice(i,1);else arr.push(key);
  state.majorCollapsed=arr;
  save();
  const el=document.getElementById('major_'+key);
  if(el)el.classList.toggle('collapsed',arr.indexOf(key)>=0);
}
function syncMajorCollapse(){
  ['chore','affair','task','archive'].forEach(function(k){
    const el=document.getElementById('major_'+k);
    if(el)el.classList.toggle('collapsed',(state.majorCollapsed||[]).indexOf(k)>=0);
  });
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
  // 兜底：窗口失焦（系统手势切走、切标签页等）时结束拖拽，避免 body 残留 overflow:hidden
  window.addEventListener('blur',onDragUp);
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
  // 幂等兜底：无论是否处于拖拽状态，都先恢复页面滚动（可被 pointerup/pointercancel/blur 重复调用）
  document.body.style.overflow='';
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

export { filterByDomain, toggleInline, toggleMajor, syncMajorCollapse, toggleCollapse, drag, dragJustEnded, initDrag, getDragTarget, onDragDown, getDragSiblings, onDragMove, onDragUp, saveTaskOrderFromDOM, saveCollectionOrderFromDOM, saveAchDomOrderFromDOM, saveAchOrderFromDOM, saveProdOrderFromDOM, saveShopCatOrderFromDOM };
