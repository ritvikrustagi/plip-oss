// Zip the unpacked extension into dist/, ready to drag onto chrome://extensions
// or to hand to whoever does the signing. It does not publish anything.
//
//   node tools/pack.mjs           # -> dist/plip-study-buddy-<version>.zip
//
// Uses the system `zip`, which macOS, Linux and ChromeOS's Linux container all
// have; there is no npm dependency anywhere in this extension.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const name = `plip-study-buddy-${manifest.version}.zip`
const target = resolve(root, 'dist', name)

mkdirSync(resolve(root, 'dist'), { recursive: true })
rmSync(target, { force: true })

// Only what the extension actually loads. tools/, dist/ and docs stay out.
const include = ['manifest.json', 'icons', 'src']
execFileSync('zip', ['-r', '-q', '-X', target, ...include], { cwd: root, stdio: 'inherit' })

const listed = execFileSync('unzip', ['-l', target], { encoding: 'utf8' })
const files = listed.trimEnd().split('\n').at(-1).trim()
console.log(`${target}\n${files}`)
