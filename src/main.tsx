import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DataProvider } from './data/store'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <DataProvider>
    <App />
  </DataProvider>
)
