import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import App from './App.vue';
import { useTheme } from './composables/useTheme';

// apply persisted theme before mounting (html.dark drives Element Plus dark vars)
useTheme();
createApp(App).use(ElementPlus, { locale: zhCn }).mount('#app');
