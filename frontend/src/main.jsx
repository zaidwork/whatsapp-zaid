import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// تسجيل Service Worker لدعم الـ PWA والتثبيت والعمل دون اتصال بالإنترنت
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('✅ PWA: Service Worker registered successfully with scope:', reg.scope))
      .catch((err) => console.error('❌ PWA: Service Worker registration failed:', err));
  });
}
