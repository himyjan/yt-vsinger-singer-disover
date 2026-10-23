import { createApp, vaporInteropPlugin } from 'vue';
import App from './App.vue';
import './index.css';

createApp(App)
  .use(vaporInteropPlugin) // Allows VDOM and Vapor to coexist
  .mount('#root')