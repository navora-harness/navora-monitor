import { installAccessibility } from '../ui/accessibility'
import { createApp } from 'vue'
import RemoteApp from './RemoteApp.vue'
import '../styles.css'
import './remote.css'

createApp(RemoteApp).mount('#app')

installAccessibility()
