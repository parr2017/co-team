import { ref } from 'vue';

export type ThemeMode = 'dark' | 'light';

const stored = (localStorage.getItem('coteam-theme') as ThemeMode) || 'dark';
const theme = ref<ThemeMode>(stored === 'light' ? 'light' : 'dark');

function apply(mode: ThemeMode) {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  localStorage.setItem('coteam-theme', mode);
}

apply(theme.value);

/** Global theme state; toggling updates <html> class and persists. */
export function useTheme() {
  const toggle = () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    apply(theme.value);
  };
  // read a CSS custom property value (for canvas-based charts)
  const cssVar = (name: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return { theme, toggle, cssVar };
}
