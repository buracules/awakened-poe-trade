// Local stop-gap for PoE 3.30 (Covens): teach APT about Viscera items
// until upstream publishes regenerated data. Idempotent: safe to re-run.
//   node renderer/scripts/patch-viscera.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../public/data/en')
const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'viscera-data.json'), 'utf-8'))

const report = { itemsAdded: 0, itemsSkipped: [], implicitIdsAdded: 0, statsCreated: 0, warnings: [] }

// ---------- items.ndjson ----------
{
  const file = path.join(DATA_DIR, 'items.ndjson')
  let text = fs.readFileSync(file, 'utf-8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const existing = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const o = JSON.parse(line)
    if (o.namespace === 'ITEM') existing.set(o.name, o)
  }
  let append = ''
  for (const base of src.bases) {
    const prev = existing.get(base)
    if (prev) {
      if (prev.craftable?.category !== 'Viscera') report.itemsSkipped.push(base)
      continue
    }
    append += JSON.stringify({
      name: base, refName: base, namespace: 'ITEM',
      craftable: { category: 'Viscera' }, icon: '', w: 2, h: 2
    }) + eol
    report.itemsAdded += 1
  }
  if (!text.endsWith('\n')) text += eol
  fs.writeFileSync(file, text + append)
}

// ---------- stats.ndjson ----------
{
  const file = path.join(DATA_DIR, 'stats.ndjson')
  const rawText = fs.readFileSync(file, 'utf-8')
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n'
  const rawLines = rawText.split(/\r?\n/).filter(Boolean)
  const parsed = rawLines.map(l => JSON.parse(l))
  const dirty = new Set()
  const byHash = new Map() // stat_123 -> [{ stat, lineIdx }]
  const byMatcher = new Map() // matcher string -> [{ stat, lineIdx }]
  const refs = new Set()

  parsed.forEach((o, lineIdx) => {
    for (const stat of (o.stats ?? [o])) {
      refs.add(stat.ref)
      for (const ids of Object.values(stat.trade?.ids ?? {})) {
        for (const id of ids) {
          const h = id.split('.')[1]
          if (!byHash.has(h)) byHash.set(h, [])
          byHash.get(h).push({ stat, lineIdx })
        }
      }
      for (const m of stat.matchers) {
        const key = m.advanced ?? m.string
        if (!byMatcher.has(key)) byMatcher.set(key, [])
        byMatcher.get(key).push({ stat, lineIdx })
      }
    }
  })

  function addImplicit ({ stat, lineIdx }, hash) {
    const id = `implicit.${hash}`
    stat.trade.ids.implicit ??= []
    if (stat.trade.ids.implicit.includes(id)) return
    stat.trade.ids.implicit.push(id)
    dirty.add(lineIdx)
    report.implicitIdsAdded += 1
  }

  // 1. stats we already know, only the implicit trade id is missing
  for (const hash of src.addImplicitId) {
    const hits = byHash.get(hash)
    if (!hits) { report.warnings.push(`no local stat for ${hash}`); continue }
    const seen = new Set()
    for (const hit of hits) {
      if (seen.has(hit.stat)) continue
      seen.add(hit.stat)
      addImplicit(hit, hash)
    }
  }

  // 2. stats not in local data at all (or under a different trade hash)
  const toMatcher = (t) => t.replace(/[+-]#/g, '#')
  const FLIP = [['increased', 'reduced'], ['reduced', 'increased'], ['more', 'less'], ['less', 'more']]
  // 3. stats reworded in 3.30 (e.g. "increased Rarity of Items found" -> "+#% to Item Rarity"):
  //    add the new text as an extra matcher, old one keeps working
  report.matchersAdded = 0
  for (const [fullId, text] of src.rewordedMatchers ?? []) {
    const matcher = toMatcher(text)
    const owners = [...new Map((byHash.get(fullId.split('.')[1]) ?? [])
      .filter(({ stat }) => Object.values(stat.trade.ids).some(ids => ids.includes(fullId)))
      .map(hit => [hit.stat, hit])).values()]
    if (owners.length !== 1) { report.warnings.push(`reword: ${owners.length} owners for ${fullId}`); continue }
    const { stat, lineIdx } = owners[0]
    const existingIdx = stat.matchers.findIndex(m => m.string === matcher)
    if (existingIdx === 0) continue
    if (existingIdx > 0) {
      // first matcher is used as the UI label: show the 3.30 wording
      stat.matchers.unshift(...stat.matchers.splice(existingIdx, 1))
      dirty.add(lineIdx)
      report.matchersAdded += 1
      continue
    }
    const other = byMatcher.get(matcher)
    if (other && other.some(o => o.stat !== stat)) { report.warnings.push(`reword: matcher taken: ${matcher}`); continue }
    stat.matchers.unshift({ string: matcher })
    for (const [from, to] of FLIP) {
      const re = new RegExp(`\\b${from}\\b`, 'g')
      if ((matcher.match(re) ?? []).length !== 1) continue
      const negated = matcher.replace(re, to)
      if (!byMatcher.has(negated)) stat.matchers.push({ string: negated, negate: true })
      break
    }
    byMatcher.set(matcher, [owners[0]])
    dirty.add(lineIdx)
    report.matchersAdded += 1
  }

  const created = new Map() // matcher -> stat
  for (const [hash, text] of src.newImplicitStats) {
    const matcher = toMatcher(text)
    const hits = byMatcher.get(matcher)
    if (hits) {
      for (const hit of hits) addImplicit(hit, hash)
      continue
    }
    if (created.has(matcher)) {
      const stat = created.get(matcher)
      const id = `implicit.${hash}`
      if (!stat.trade.ids.implicit.includes(id)) stat.trade.ids.implicit.push(id)
      continue
    }
    const matchers = [{ string: matcher }]
    for (const [from, to] of FLIP) {
      const re = new RegExp(`\\b${from}\\b`, 'g')
      if ((matcher.match(re) ?? []).length !== 1) continue
      const negated = matcher.replace(re, to)
      if (byMatcher.has(negated)) {
        report.warnings.push(`skip negated matcher (exists): ${negated}`)
      } else {
        matchers.push({ string: negated, negate: true })
      }
      break
    }
    let ref = text
    if (refs.has(ref)) { report.warnings.push(`ref exists, suffixing: ${ref}`); ref = `${ref} (viscera)` }
    refs.add(ref)
    const stat = { ref, better: 1, matchers, trade: { ids: { implicit: [`implicit.${hash}`] } } }
    created.set(matcher, stat)
    report.statsCreated += 1
  }

  const out = rawLines.map((line, idx) => dirty.has(idx) ? JSON.stringify(parsed[idx]) : line)
  for (const stat of created.values()) out.push(JSON.stringify(stat))
  fs.writeFileSync(file, out.join(eol) + eol)
}

console.log(JSON.stringify(report, null, 2))
