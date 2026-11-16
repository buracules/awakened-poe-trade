// Local stop-gap for PoE 3.30 (Covens): stats the trade site knows and this
// build's stats.ndjson lacks, added one at a time as they turn up on items.
// Idempotent: safe to re-run.
//   node renderer/scripts/patch-stats.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(__dirname, '../public/data/en/stats.ndjson')
const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'stats-data.json'), 'utf-8'))

const text = fs.readFileSync(file, 'utf-8')
const eol = text.includes('\r\n') ? '\r\n' : '\n'
const lines = text.split(/\r?\n/).filter(Boolean)
const matchers = new Set()
const ids = new Set()
for (const line of lines) {
  const o = JSON.parse(line)
  for (const stat of (o.stats ?? [o])) {
    for (const m of stat.matchers) matchers.add(m.advanced ?? m.string)
    for (const list of Object.values(stat.trade?.ids ?? {})) for (const id of list) ids.add(id)
  }
}

const FLIP = [['increased', 'reduced'], ['reduced', 'increased'], ['more', 'less'], ['less', 'more']]
const toMatcher = (t) => t.replace(/[+-]#/g, '#')
const entries = [...src.add, ...(src.bulk ?? [])]
// a text the trade site lists as its own stat must not be claimed as another stat's negation
const ownTexts = new Set(entries.flatMap(e => [e.text, ...(e.alt ?? [])]).map(toMatcher))
const report = { added: 0, skipped: 0, examples: [] }

for (const e of entries) {
  const texts = [...new Set([e.text, ...(e.alt ?? [])].map(toMatcher))]
  if (texts.some(m => matchers.has(m)) || Object.values(e.ids).flat().some(id => ids.has(id))) {
    report.skipped += 1
    continue
  }
  const stat = { ref: e.text, better: 1, matchers: texts.map(string => ({ string })), trade: { ids: e.ids } }
  for (const [from, to] of FLIP) {
    const re = new RegExp(`\\b${from}\\b`, 'g')
    if ((texts[0].match(re) ?? []).length !== 1) continue
    const negated = texts[0].replace(re, to)
    if (!matchers.has(negated) && !ownTexts.has(negated)) {
      stat.matchers.push({ string: negated, negate: true })
      matchers.add(negated)
    }
    break
  }
  lines.push(JSON.stringify(stat))
  for (const m of texts) matchers.add(m)
  for (const id of Object.values(e.ids).flat()) ids.add(id)
  report.added += 1
  if (report.examples.length < 5) report.examples.push(e.text)
}

fs.writeFileSync(file, lines.join(eol) + eol)
console.log(JSON.stringify(report, null, 1))
