import { THEME_KEY } from './constants.js';
import { render } from './render.js';
// theme.js —— 主题切换
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Theme =====
function initTheme(){
  const saved=localStorage.getItem(THEME_KEY);
  const prefersDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme=saved||(prefersDark?'dark':'light');
  applyTheme(theme);
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme',theme);
  const btn=document.getElementById('themeToggle');
  if(btn)btn.textContent=theme==='dark'?'☀️':'🌙';
}
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme')||'light';
  const next=cur==='dark'?'light':'dark';
  localStorage.setItem(THEME_KEY,next);
  applyTheme(next);
  render();
}

export { initTheme, applyTheme, toggleTheme };
