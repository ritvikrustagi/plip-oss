/**
 * Loads a class roster from CSV.
 *
 *   node server/roster-import.mjs --classes classes.csv --enrolments enrolments.csv
 *
 * classes.csv      classId,name,joinCode,plannedConceptIds
 *                  cls_math7a,"Math 7 · Period 2",MATH-7A2,"fractions.add-unlike;ratios.unit-rate"
 * enrolments.csv   classId,email,role[,displayName]
 *                  cls_math7a,rivera@school.example,teacher,Ms Rivera
 *                  cls_math7a,avery@school.example,student,Avery L.
 *
 * displayName is optional and is what a teacher sees on their roster; without
 * it the part of the address before the @ is used until that person signs in
 * and their provider tells us their name. It is the only place a name lives:
 * learning events never carry one.
 *
 * The import replaces the roster rather than adding to it: a class or an
 * enrolment that is no longer in the file is removed, so a student who left a
 * class stops being visible to its teacher on the next sync. Emails are only
 * used to match a person to their rows; the id an event carries is generated
 * here and is not derived from the address.
 *
 * This is the smallest useful shape. A school with OneRoster or Clever should
 * point its own export at the same two tables - see docs/CHROMEBOOK.md.
 */
import { readFileSync } from 'node:fs'

import { load } from './config.mjs'
import { createStore } from './db/index.mjs'

/**
 * A small RFC-4180 reader: quoted fields, doubled quotes inside them, and
 * newlines inside quotes. No dependency for something this size.
 * @param {string} text @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = []
  /** @type {string[]} */
  let row = []
  let field = ''
  let quoted = false
  let index = 0
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  while (index < body.length) {
    const char = body[index]
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') { field += '"'; index += 2; continue }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') { quoted = true; index += 1; continue }
    if (char === ',') { row.push(field); field = ''; index += 1; continue }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; index += 1; continue }
    field += char
    index += 1
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((line) => line.some((cell) => cell.trim() !== ''))
}

/** @param {string[][]} rows @returns {Record<string, string>[]} */
function withHeader(rows) {
  if (!rows.length) return []
  const header = rows[0].map((name) => name.trim())
  return rows.slice(1).map((line) => Object.fromEntries(header.map((name, column) => [name, (line[column] ?? '').trim()])))
}

/** @param {string} classesCsv @param {string} enrolmentsCsv */
export function readRoster(classesCsv, enrolmentsCsv) {
  const classes = withHeader(parseCsv(classesCsv)).map((row, index) => {
    for (const field of ['classId', 'name', 'joinCode'])
      if (!row[field]) throw new Error(`classes.csv row ${index + 2}: ${field} is required`)
    return {
      classId: row.classId,
      name: row.name,
      joinCode: row.joinCode.toUpperCase(),
      plannedConceptIds: (row.plannedConceptIds ?? '').split(/[;|]/).map((part) => part.trim()).filter(Boolean),
    }
  })
  const known = new Set(classes.map((klass) => klass.classId))
  const codes = new Set()
  for (const klass of classes) {
    if (codes.has(klass.joinCode)) throw new Error(`two classes share the join code ${klass.joinCode}`)
    codes.add(klass.joinCode)
  }

  const enrolments = withHeader(parseCsv(enrolmentsCsv)).map((row, index) => {
    const line = index + 2
    if (!known.has(row.classId)) throw new Error(`enrolments.csv row ${line}: no class called ${row.classId || '(blank)'} in classes.csv`)
    if (!row.email || !row.email.includes('@')) throw new Error(`enrolments.csv row ${line}: ${row.email || '(blank)'} is not an email address`)
    if (row.role !== 'student' && row.role !== 'teacher') throw new Error(`enrolments.csv row ${line}: role must be student or teacher, not ${row.role || '(blank)'}`)
    return { classId: row.classId, email: row.email.toLowerCase(),
      role: /** @type {'student' | 'teacher'} */ (row.role), displayName: row.displayName || '' }
  })

  for (const klass of classes)
    if (!enrolments.some((row) => row.classId === klass.classId && row.role === 'teacher'))
      throw new Error(`${klass.classId} has no teacher in enrolments.csv; nobody would be able to see its summary`)

  return { classes, enrolments }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const args = process.argv.slice(2)
  const value = (/** @type {string} */ name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const classesPath = value('--classes')
  const enrolmentsPath = value('--enrolments')
  if (!classesPath || !enrolmentsPath) {
    console.error('usage: node server/roster-import.mjs --classes classes.csv --enrolments enrolments.csv')
    process.exit(2)
  }
  try {
    const config = load()
    const store = await createStore(config)
    if (!('replaceRoster' in store))
      throw new Error('a roster needs somewhere to live: set PLIP_DATABASE (with PLIP_MODE=production for a real one). '
        + 'The in-memory demo store takes its roster from the fixtures instead.')
    const roster = readRoster(readFileSync(classesPath, 'utf8'), readFileSync(enrolmentsPath, 'utf8'))
    const result = store.replaceRoster(roster)
    store.audit({ action: 'roster_import', detail: `${result.classes} classes, ${roster.enrolments.length} enrolments` })
    console.log(`imported ${result.classes} classes, ${result.enrolments} enrolments`)
    console.log(`  ${result.awaitingFirstSignIn} people have not signed in yet; their teachers can already see them on the roster`)
    store.close()
  } catch (error) {
    console.error(`roster import failed: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
