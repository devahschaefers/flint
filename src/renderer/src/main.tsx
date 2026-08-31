import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/tokens.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useAppStore } from './store'

// Hydrate accounts and mail from the local store
void useAppStore.getState().init()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
