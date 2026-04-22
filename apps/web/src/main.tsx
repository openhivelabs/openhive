import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { App } from './App'
import '../app/globals.css'

const router = createBrowserRouter([{ path: '/', element: <App /> }])

const root = document.getElementById('root')
if (!root) throw new Error('root element not found')
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
