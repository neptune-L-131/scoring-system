// render-targets.js —— 面板级渲染目标注册表（第五轮 S3-A/S3-B）
//
// 只提供按名重绘单个面板的能力；现有调用点仍只调全量 render()，全量渲染是唯一实际路径。
// 未知面板名按空操作处理：返回 false、不抛错、不改动任何 DOM。
const targets = new Map();

function registerPanelTarget(name, fn) {
  if (typeof fn === 'function') targets.set(name, fn);
}

function panelTarget(name) {
  return targets.get(name) || null;
}

function panelTargetNames() {
  return Array.from(targets.keys());
}

// 只重绘指定面板；未知名称返回 false（空操作）
function renderPanel(name) {
  const fn = targets.get(name);
  if (!fn) return false;
  fn();
  return true;
}

export { registerPanelTarget, panelTarget, panelTargetNames, renderPanel };
