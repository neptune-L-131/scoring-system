import { STAGE_NAMES } from './constants.js';
import { save } from './persist.js';
import { calcCheckIn, fmt, stageCellLabel, stageNetAt, stageSel, taskHasType, taskIsStaged } from './pure.js';
import { state } from './state.js';
// stage-bars.js —— 任务卡片的阶段奖励滑杆（从 render-work.js 原样抽出，行为不变）

function stageBarHTML(t){
  const cell=stageSel(t);
  const hasV=taskHasType(t,'vitality');
  const hasP=taskHasType(t,'progress');
  // 阶段预览显示实际结算值：档位值 + 连胜利息 - 待扣债
  const c=calcCheckIn(t);
  let reward='+'+fmt(hasV?stageNetAt(t,'vitality',cell,c):stageNetAt(t,'progress',cell,c));
  reward+=hasV&&hasP?(' 活力 / +'+fmt(stageNetAt(t,'progress',cell,c))+' 进度'):(hasV?' 活力':' 进度');
  const label=stageCellLabel(cell);
  let ticks='';
  for(let i=0;i<10;i++){ticks+='<i class="stage-tick'+(i%2===0?' major':'')+'" style="left:'+(i*10)+'%"></i>';}
  const anchorLabels=STAGE_NAMES.map((n,k)=>'<span'+(k===(cell>>1)?' class="on"':'')+' style="left:'+(k*20)+'%">'+n+'</span>').join('');
  let curStreak=t.streak||0;if(curStreak===0&&t.lastCheckIn)curStreak=1;
  let meta='';if(c.bonus>0)meta+='利息+'+fmt(c.bonus);
  if(curStreak>0)meta+=(meta?' · ':'')+'连胜'+curStreak+'天';
  const pend=t.pendingDebt||0;if(pend>0)meta+=(meta?' · ':'')+'待扣债'+fmt(pend);
  return '<div class="stage-bar" data-tid="'+t.id+'">'
    +'<div class="stage-track">'+ticks+'<div class="stage-thumb" style="left:'+(cell*10+5)+'%"></div></div>'
    +'<div class="stage-labels">'+anchorLabels+'</div>'
    +'<div class="stage-preview">'+label+' · '+reward+(meta?' · '+meta:'')+'</div>'
    +'</div>';
}

// ===== 阶段奖励：卡片进度条拖拽 =====
// 单个进度条实例的显示更新（滑块位置 / 档位名高亮 / 数值预览）
function applyStageBar(bar,t,cell){
  if(!bar)return;
  const track=bar.querySelector('.stage-track');
  if(track){const thumb=track.querySelector('.stage-thumb');if(thumb)thumb.style.left=(cell*10+5)+'%';}
  bar.querySelectorAll('.stage-labels span').forEach(function(n,k){n.classList.toggle('on',k===(cell>>1));});
  const preview=bar.querySelector('.stage-preview');
  if(preview){
    const hasV=taskHasType(t,'vitality'),hasP=taskHasType(t,'progress');
    const cc=calcCheckIn(t);
    let reward='+'+fmt(hasV?stageNetAt(t,'vitality',cell,cc):stageNetAt(t,'progress',cell,cc));
    reward+=hasV&&hasP?(' 活力 / +'+fmt(stageNetAt(t,'progress',cell,cc))+' 进度'):(hasV?' 活力':' 进度');
    let cs=t.streak||0;if(cs===0&&t.lastCheckIn)cs=1;
    let meta='';if(cc.bonus>0)meta+='利息+'+fmt(cc.bonus);
    if(cs>0)meta+=(meta?' · ':'')+'连胜'+cs+'天';
    const pend2=t.pendingDebt||0;if(pend2>0)meta+=(meta?' · ':'')+'待扣债'+fmt(pend2);
    preview.textContent=stageCellLabel(cell)+' · '+reward+(meta?' · '+meta:'');
  }
}
// 同一任务在卡片中存在两个进度条实例（长按展开前 / 展开后），统一按 state 中的唯一值刷新
function updateStageBar(track,tid,cell){
  const t=state.tasks.find(x=>x.id===tid);if(!t)return;
  document.querySelectorAll('.stage-bar[data-tid="'+tid+'"]').forEach(function(bar){
    applyStageBar(bar,t,cell);
  });
}
// 指针横坐标比例 → 0..9 格位。按“最近格心”吸附：
// 滑块画在 cell*10+5% 处，若用 floor(p*10) 会最多领先指针一格（602px 轨道约 60px），
// 看起来就是滑块跟不上手。改取最近格心后误差不超过半格。
function stageCellFromRatio(p){
  const c=Math.round(p*10-0.5);
  return c<0?0:(c>9?9:c);
}
function setStageFromX(track,tid,clientX){
  const t=state.tasks.find(x=>x.id===tid);if(!t||!taskIsStaged(t))return;
  const rect=track.getBoundingClientRect();
  if(!rect.width)return;
  let p=(clientX-rect.left)/rect.width;
  p=Math.max(0,Math.min(1,p));
  const cell=stageCellFromRatio(p); // 吸附到 10 个格位 0..9
  if(t.stageRewards)t.stageRewards.last=cell;
  updateStageBar(track,tid,cell);
}
function initStageBars(){
  const THRESH=8;
  document.querySelectorAll('.stage-bar[data-tid]').forEach(function(bar){
    const track=bar.querySelector('.stage-track');
    if(!track||track._stageBound)return;
    track._stageBound=true;
    const tid=bar.dataset.tid;
    let startX=0,startY=0,pid=null;
    // dragging 表示方向已判定并进入拖动；它不随每次 pointermove 复位，
    // 也不用来表示“本次手势结束”（结束只看 pointerup/pointercancel）。
    let dragging=false,dirty=false;
    track.addEventListener('pointerdown',function(e){
      if(!state.tasks.find(x=>x.id===tid))return;
      startX=e.clientX;startY=e.clientY;pid=e.pointerId;
      dragging=false;dirty=false;
      // 立即接管指针：手指/鼠标离开 22px 窄带后仍能收到 pointermove
      if(track.setPointerCapture){try{track.setPointerCapture(pid);}catch(err){}}
    });
    track.addEventListener('pointermove',function(e){
      if(pid===null||e.pointerId!==pid)return;
      const dx=e.clientX-startX,dy=e.clientY-startY;
      if(!dragging){
        if(Math.abs(dx)<THRESH&&Math.abs(dy)<THRESH)return;
        // 方向判定只决定“是否开始拖”，不再把纵向优先当成终止：
        // 先纵向晃一下、再横向移动时依然能开始拖动（触屏纵向滚动由浏览器 pointercancel 接管）。
        if(Math.abs(dx)<=Math.abs(dy))return;
        dragging=true;dirty=true;
      }
      e.preventDefault();
      setStageFromX(track,tid,e.clientX);
    });
    function end(e,isCancel){
      if(pid===null||e.pointerId!==pid)return;
      if(track.releasePointerCapture){try{track.releasePointerCapture(pid);}catch(err){}}
      const tap=!dragging&&!isCancel&&Math.abs(e.clientX-startX)<THRESH&&Math.abs(e.clientY-startY)<THRESH;
      pid=null;
      // 阶段档位是单字段写入，无中途失败路径，直接落盘
      if(tap){
        // 点哪跳哪：轻点轨道与点击滑块同义
        setStageFromX(track,tid,e.clientX);
        save();
      }else if(dirty){
        save();
      }
      dragging=false;dirty=false;
    }
    track.addEventListener('pointerup',function(e){end(e,false);});
    track.addEventListener('pointercancel',function(e){end(e,true);});
  });
}

export { stageBarHTML, applyStageBar, updateStageBar, stageCellFromRatio, setStageFromX, initStageBars };
