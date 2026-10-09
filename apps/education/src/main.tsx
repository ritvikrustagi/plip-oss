/**
 * Two surfaces behind one bundle: the student session and the teacher
 * dashboard. Which one you get follows the role of the demo identity you picked
 * - a student can never render the teacher view, and the API would refuse it
 * anyway.
 *
 * The hash (#/student, #/teacher) is a hint for the PWA shortcuts and for
 * deep links; the role still decides.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles.css'
import { registerServiceWorker } from './lib/pwa'
import { actions, sessionStore } from './lib/session'
import { useStore } from './store'
import { Consent } from './views/Consent'
import { SignIn } from './views/SignIn'
import { Starting } from './views/Starting'
import { Student } from './views/Student'
import { Teacher } from './views/Teacher'

function App() {
  const state = useStore(sessionStore)
  if (state.stage === 'starting') return <Starting />
  if (!state.identity) return <SignIn />
  if (state.identity.role === 'teacher') return <Teacher />
  if (state.stage === 'consent') return <Consent />
  return <Student />
}

// Which deployment is this, and is anybody already signed in? A reload inside
// a session lands the student back on their own screen either way: the demo
// token is in sessionStorage, the real one is an HttpOnly cookie.
void actions.bootstrap()

registerServiceWorker()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
