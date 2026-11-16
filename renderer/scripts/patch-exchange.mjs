// Local stop-gap for PoE 3.30 (Covens): bulk-exchange items the trade site
// lists but this build's items.ndjson lacks. Idempotent: safe to re-run.
//   node renderer/scripts/patch-exchange.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(__dirname, '../public/data/en/items.ndjson')
const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'exchange-data.json'), 'utf-8'))

const text = fs.readFileSync(file, 'utf-8')
const eol = text.includes('\r\n') ? '\r\n' : '\n'
const lines = text.split(/\r?\n/).filter(Boolean)
const byName = new Map(lines.map((l, i) => [JSON.parse(l).name, i]))
const tags = new Set(lines.map(l => JSON.parse(l).tradeTag).filter(Boolean))
const report = { added: [], tagged: [], skipped: [] }

for (const e of src.tagExisting) {
  const i = byName.get(e.text)
  if (i == null) { report.skipped.push(e.text + ' (not found)'); continue }
  const o = JSON.parse(lines[i])
  if (o.tradeTag) { report.skipped.push(e.text); continue }
  // keep key order stable: tradeTag/exchangeable sit after namespace in upstream data
  const { name, refName, namespace, ...rest } = o
  lines[i] = JSON.stringify({ name, refName, namespace, tradeTag: e.id, exchangeable: true, ...rest })
  report.tagged.push(e.text)
}

for (const e of src.add) {
  if (byName.has(e.text) || tags.has(e.id)) { report.skipped.push(e.text); continue }
  lines.push(JSON.stringify({
    name: e.text, refName: e.text, namespace: 'ITEM',
    tradeTag: e.id, exchangeable: true,
    icon: 'https://web.poecdn.com' + e.image
  }))
  report.added.push(e.text)
}

fs.writeFileSync(file, lines.join(eol) + eol)
console.log(JSON.stringify({ added: report.added.length, tagged: report.tagged, skipped: report.skipped.length }, null, 1))
