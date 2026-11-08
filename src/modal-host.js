// modal-host.js —— 模态框显隐原语（只有 DOM 操作，无业务依赖）
// 由 modals.js 抽离（第六轮循环依赖治理），实现逐字未改。
function openModal(id){document.getElementById(id).classList.add('show')}
function closeModal(id){document.getElementById(id).classList.remove('show')}
export { openModal, closeModal };
