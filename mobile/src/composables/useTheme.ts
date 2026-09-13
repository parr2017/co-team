import { ref } from 'vue';

export type ThemeMode = 'dark' | 'light';

const stored = (localStorage.getItem('coteam-theme') as ThemeMode) || 'dark';
const theme = ref<ThemeMode>(stored === 'light' ? 'light' : 'dark');

function apply(mode: ThemeMode) {
  document.documentElement.classList.toggle('light', mode === 'light');
  localStorage.setItem('coteam-theme', mode);
  // PWA/浏览器 chrome 主题色跟随（index.html 的静态 theme-color 不随主题变）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'light' ? '#f5f6f8' : '#0b0c0e');
}

apply(theme.value);

/** M10-B 双主题：切换更新 <html> class 并持久化（dark 默认，light 走 html.light token 组） */
export function useTheme() {
  const toggle = () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    apply(theme.value);
  };
  return { theme, toggle };
}
