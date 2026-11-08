import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SharePage from './pages/SharePage.tsx'

// No router installed — the QR-code share flow (ShareQR.tsx) only ever
// needs this one extra route, so a plain pathname check is enough. Vite's
// dev server (and any static host serving this as an SPA) already falls
// back to index.html for unmatched paths, so /share reaches this code.
const isSharePage = window.location.pathname === '/share'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isSharePage ? <SharePage /> : <App />}
  </StrictMode>,
)
