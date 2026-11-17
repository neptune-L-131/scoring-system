// persist-state.js —— 读档失败时的写盘暂停标记
// 从 normalize.js 抽出，供 normalize 与 persist 共用，避免二者互相依赖，行为不变。
let _persistBlocked = false;

function setPersistBlocked(v){_persistBlocked = !!v;}

export { _persistBlocked, setPersistBlocked };
