// view-primitives.js —— 卡片 / 折叠组 / 列表行的外壳原语（第五轮 S3-A）
//
// 只拼接 HTML 片段，不读 state、不做业务计算、不触发渲染。
// 所有片段与既有模板逐字一致（含空格与属性顺序），用于后续逐面板切片时复用。
// 文本参数由调用方负责转义，与抽取前的拼接方式保持一致。

function tagHTML(kind, text) {
  return '<span class="tag ' + kind + '">' + text + '</span>';
}

function dragHandleHTML(title) {
  return '<span class="drag-handle" title="' + title + '">⋮⋮</span>';
}

// 操作行：card-actions / affair-actions / task-row-actions 共用
function actionsRowHTML(cls, inner, stopPropagation) {
  return '<div class="' + cls + '"' + (stopPropagation ? ' onclick="event.stopPropagation()"' : '') + '>' + inner + '</div>';
}

// 折叠组外壳（coll-group / ach-dom-group / shop-cat-group 共用）
function collGroupHTML(cls, dataAttr, collapsed, inner) {
  return '<div class="' + cls + (collapsed ? ' collapsed' : '') + '" ' + dataAttr + '>' + inner + '</div>';
}

function collBodyHTML(inner) {
  return '<div class="coll-body">' + inner + '</div>';
}

// 折叠组标题行；actions 为 null/undefined 时不渲染 coll-actions 容器
function collHeaderHTML(opts) {
  return '<div class="coll-header" onclick="' + opts.onclick + '">'
    + '<div class="coll-name"><span class="coll-toggle">▼</span>' + opts.name + ' <span class="coll-count">' + opts.count + opts.countLabel + '</span></div>'
    + (opts.actions == null ? '' : '<div class="coll-actions" onclick="event.stopPropagation()">' + opts.actions + '</div>')
    + '</div>';
}

// 区域（affair-zone）起始片段；刻意不闭合，保持与既有 affairZoneStart + AFFAIR_ZONE_END 的拼法一致
function zoneStartHTML(opts) {
  return '<div class="affair-zone' + (opts.collapsed ? ' collapsed' : '') + '" id="' + opts.id + '">'
    + '<div class="affair-zone-title" onclick="' + opts.onclick + '">'
    + '<span class="coll-toggle">▼</span>' + opts.title + ' <span class="affair-zone-count">' + opts.count + '</span>'
    + (opts.extra || '')
    + '</div>'
    + '<div class="affair-zone-body">';
}
const ZONE_END = '</div></div>';

function zoneHTML(opts) {
  return zoneStartHTML(opts) + opts.body + ZONE_END;
}

function emptyHTML(cls, text) {
  return '<div class="' + cls + '">' + text + '</div>';
}

// 流水行 / 余额调整行共用结构；action 为可选的尾部按钮
function logItemHTML(o) {
  return '<div class="log-item">'
    + '<div class="log-dot ' + o.dot + '"></div>'
    + '<div class="log-desc">' + o.desc + '</div>'
    + '<div class="log-amt ' + o.amtCls + '">' + o.amt + '</div>'
    + '<div class="log-time">' + o.time + '</div>'
    + (o.action || '')
    + '</div>';
}

export {
  tagHTML, dragHandleHTML, actionsRowHTML,
  collGroupHTML, collBodyHTML, collHeaderHTML,
  zoneStartHTML, zoneHTML, ZONE_END, emptyHTML, logItemHTML,
};
