/**
 * One command for the whole demo: the local API and the Vite dev server.
 *   npm run dev   ->  http://localhost:5273
 */
import { spawn } from 'node:child_process'

/** @type {import('node:child_process').ChildProcess[]} */
const children = []
/** @param {string} label @param {string[]} command */
const run = (label, command) => {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env } })
  child.on('exit', (code) => {
    console.log(`${label} exited (${code})`)
    stop()
  })
  children.push(child)
}

function stop() {
  for (const child of children) if (!child.killed) child.kill()
}

process.on('SIGINT', () => { stop(); process.exit(0) })
process.on('SIGTERM', () => { stop(); process.exit(0) })

run('demo API', [process.execPath, 'server/demo-api.mjs'])
run('vite', [process.platform === 'win32' ? 'npx.cmd' : 'npx', 'vite'])
