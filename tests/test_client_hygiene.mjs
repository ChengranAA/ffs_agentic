import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILES = [
  'ffs-analysis-ui/client.js',
  'ffs-record/client.js',
  'ffs-harness-viewer/client.js',
]
const HOOKS = ['useCallback', 'useContext', 'useEffect', 'useId', 'useLayoutEffect',
  'useMemo', 'useReducer', 'useRef', 'useState']

for (const file of FILES) {
  test(`${file} destructures every React hook it calls`, () => {
    const source = readFileSync(path.join(ROOT, file), 'utf8')
    const destructure = /const \{([^}]*)\} = React/.exec(source)?.[1] || ''
    const declared = new Set(destructure.split(',').map((item) => item.trim()).filter(Boolean))
    for (const hook of HOOKS) {
      const bare = new RegExp(`(?<!React\\.)\\b${hook}\\(`, 'g')
      const uses = source.match(bare) || []
      if (!uses.length) continue
      assert.ok(declared.has(hook), `${file} calls ${hook} but does not destructure it from React`)
    }
  })
}
