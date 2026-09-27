import { ref } from 'vue';

export type ThemeMode = 'dark' | 'light';

const stored = (localStorage.getItem('coteam-theme') as ThemeMode) || 'light';
const theme = ref<ThemeMode>(stored === 'dark' ? 'dark' : 'light');

function apply(mode: ThemeMode) {
  document.documentElement.classList.toggle('light', mode === 'light');
  localStorage.setItem('coteam-theme', mode);
  // PWA/浏览器 chrome 主题色跟随（index.html 的静态 theme-color 不随主题变）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'light' ? '#f5f6f8' : '#0c0d10');
}

apply(theme.value);

/** M10-B 双主题：切换更新 <html> class 并持久化（light 默认，dark 走 :root 暗色 token 组） */
export function useTheme() {
  const toggle = () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    apply(theme.value);
  };
  return { theme, toggle };
}
