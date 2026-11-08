import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ParticleField } from './components/ParticleField.tsx'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <>
    <ParticleField />
    <StrictMode>
      <App />
    </StrictMode>
  </>,
)
