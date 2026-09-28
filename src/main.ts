import { createApp } from 'vue'
import { createMonitorApi } from './api/bridge'
import App from './App.vue'
import './styles.css'

window.navoraMonitor = createMonitorApi()

createApp(App).mount('#app')
