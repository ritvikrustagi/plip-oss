/**
 * PWA icons from the Plip mark in assets/. Run on a Mac (sips) when the mark
 * changes; the results are committed so a Chromebook install needs no toolchain.
 *   npm run icons
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../../assets/plip-icon.png', import.meta.url))
const out = fileURLToPath(new URL('../public', import.meta.url))
mkdirSync(out, { recursive: true })

for (const size of [192, 512]) {
  execFileSync('sips', ['-Z', String(size), source, '--out', `${out}/icon-${size}.png`], { stdio: 'ignore' })
  console.log(`icon-${size}.png`)
}
// Maskable: Android and ChromeOS crop to a circle, so the mark needs padding
// inside the square. 512 canvas, mark at 410, centred on Plip's ink background.
execFileSync('sips', ['-Z', '410', source, '--out', `${out}/icon-maskable-512.png`], { stdio: 'ignore' })
execFileSync('sips', ['-p', '512', '512', '--padColor', '06070A', `${out}/icon-maskable-512.png`,
  '--out', `${out}/icon-maskable-512.png`], { stdio: 'ignore' })
console.log('icon-maskable-512.png')
copyFileSync(fileURLToPath(new URL('../../../src/mcp_vision/buddy/plip-mark.svg', import.meta.url)), `${out}/icon.svg`)
console.log('icon.svg')
