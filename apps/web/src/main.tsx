import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { Root } from './Root'
import { Dashboard } from './routes/Dashboard'
import { Home } from './routes/Home'
import { New } from './routes/New'
import { Onboarding } from './routes/Onboarding'
import { Primitives } from './routes/Primitives'
import { Records } from './routes/Records'
import { Session } from './routes/Session'
import { Settings } from './routes/Settings'
import { Tasks } from './routes/Tasks'
import { Team } from './routes/Team'
import { TeamLayout } from './routes/TeamLayout'
import './globals.css'

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { index: true, element: <Home /> },
      { path: 'onboarding', element: <Onboarding /> },
      { path: 'settings', element: <Settings /> },
      { path: 'primitives', element: <Primitives /> },
      {
        path: ':companySlug/:teamSlug',
        element: <TeamLayout />,
        children: [
          { path: 'team', element: <Team /> },
          { path: 'tasks', element: <Tasks /> },
          { path: 'records', element: <Records /> },
          { path: 'dashboard', element: <Dashboard /> },
          { path: 'new', element: <New /> },
          { path: 's/:sessionId', element: <Session /> },
        ],
      },
    ],
  },
])

const root = document.getElementById('root')
if (!root) throw new Error('root element not found')
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
