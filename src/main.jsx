import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Let the browser paint the page that is already in the HTML first, then start the app.
// This keeps the first visible paint independent of the (large) app code, so it is fast and steady.
const root = ReactDOM.createRoot(document.getElementById('root'))
let started = false
const start = () => {
  if (started) return
  started = true
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
if (typeof requestAnimationFrame === 'function') {
  requestAnimationFrame(() => setTimeout(start, 0))
}
// Safety net: if the tab is in the background (no frames are drawn), start anyway.
setTimeout(start, 400)
