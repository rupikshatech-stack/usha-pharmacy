import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installChunkReload } from './utils/chunkReload'

// A tab opened before a deploy still asks for the old build's chunk names; reload once to pick up the new ones.
installChunkReload()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
