import { STAGE_PRESET_KEY } from './constants.js';
import { defaults } from './defaults.js';
// state.js —— 全局可变状态容器、阶段奖励预设
// 由 app.js 按功能拆分（第五轮可维护性重构），第六轮把常量/纯函数/默认值下沉，行为不变。

let state=defaults();

// ===== 阶段奖励预设 =====
let stagePresets={stepPct:50,decreasePct:100};
function loadStagePresets(){
  const p={stepPct:50,decreasePct:100};
  try{
    const raw=localStorage.getItem(STAGE_PRESET_KEY);
    if(raw){const o=JSON.parse(raw);if(typeof o.stepPct==='number')p.stepPct=o.stepPct;if(typeof o.decreasePct==='number')p.decreasePct=o.decreasePct;}
  }catch(e){}
  return p;
}
function saveStagePresets(){try{localStorage.setItem(STAGE_PRESET_KEY,JSON.stringify(stagePresets));}catch(e){}}

export function getState(){return state;}
export function setState(next){state=next;}
export function initStagePresets(){stagePresets=loadStagePresets();}
export function resetStagePresets(){stagePresets={stepPct:50,decreasePct:100};}

export { state };
export { stagePresets, loadStagePresets, saveStagePresets };
