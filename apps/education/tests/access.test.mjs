/** Role separation, authorized class membership, roster membership, opt-in eligibility. */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AccessError, authorizeRosterMember, authorizeStudentClass, authorizeStudentSelf,
  authorizeTeacherClass, eligibleForTeacher, requireIdentity, requireRole,
} from '../shared/access.mjs'
import { loadFixtures } from '../server/store.mjs'

const { classes, identities } = loadFixtures()
const who = (/** @type {string} */ token) => /** @type {import('../shared/access.mjs').Identity} */ (identities.get(token))
const rivera = who('demo-teacher-rivera')
const okafor = who('demo-teacher-okafor')
const avery = who('demo-student-avery')
const bo = who('demo-student-bo')
const mathA = /** @type {import('../shared/access.mjs').ClassRecord} */ (classes.get('cls_math7a'))

/** @param {() => unknown} fn @param {string} code */
function refuses(fn, code) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof AccessError, `expected an AccessError, got ${error}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected ${code}, but it was allowed`)
}

test('no token, no access', () => {
  refuses(() => requireIdentity(null), 'no_identity')
  refuses(() => requireRole(undefined, 'teacher'), 'no_identity')
})

test('a student cannot act as a teacher, and a teacher cannot act as a student', () => {
  refuses(() => requireRole(avery, 'teacher'), 'wrong_role')
  refuses(() => requireRole(rivera, 'student'), 'wrong_role')
  refuses(() => authorizeTeacherClass(avery, 'cls_math7a', classes), 'wrong_role')
  refuses(() => authorizeStudentSelf(rivera, 'stu_a1b2'), 'wrong_role')
})

test('a teacher reaches their own class and nothing else', () => {
  assert.equal(authorizeTeacherClass(rivera, 'cls_math7a', classes).klass.classId, 'cls_math7a')
  refuses(() => authorizeTeacherClass(rivera, 'cls_math7b', classes), 'class_not_authorized')
  refuses(() => authorizeTeacherClass(okafor, 'cls_math7a', classes), 'class_not_authorized')
})

test('a class that does not exist is refused the same way as one that is not yours', () => {
  const missing = refuses(() => authorizeTeacherClass(rivera, 'cls_nope', classes), 'class_not_authorized')
  const theirs = refuses(() => authorizeTeacherClass(rivera, 'cls_math7b', classes), 'class_not_authorized')
  assert.equal(missing.message, theirs.message)
  assert.equal(missing.status, theirs.status)
})

test('a forged identity claiming a class it does not teach is still refused', () => {
  /** @type {import('../shared/access.mjs').Identity} */
  const forged = { id: 'tea_forged', role: 'teacher', teacherId: 'tea_forged', displayName: 'nope', classIds: ['cls_math7a'] }
  refuses(() => authorizeTeacherClass(forged, 'cls_math7a', classes), 'class_not_authorized')
})

test('a teacher only reaches students their roster lists', () => {
  assert.equal(authorizeRosterMember(mathA, 'stu_c3d4'), 'stu_c3d4')
  refuses(() => authorizeRosterMember(mathA, 'stu_j9k0'), 'not_on_roster')
})

test('a student only touches their own work', () => {
  assert.equal(authorizeStudentSelf(avery, 'stu_a1b2').studentId, 'stu_a1b2')
  refuses(() => authorizeStudentSelf(avery, 'stu_c3d4'), 'not_own_data')
})

test('a student only links sessions to classes they are in', () => {
  assert.equal(authorizeStudentClass(avery, 'cls_math7b', classes).classId, 'cls_math7b')
  refuses(() => authorizeStudentClass(bo, 'cls_math7b', classes), 'class_not_joined')
  refuses(() => authorizeStudentClass(bo, 'cls_nope', classes), 'class_not_joined')
})

test('eligibility: opted in, this class, on the roster - all three or nothing', () => {
  const events = [
    { eventId: 'a', studentId: 'stu_c3d4', classId: 'cls_math7a', shareWithTeacher: true },   // yes
    { eventId: 'b', studentId: 'stu_c3d4', classId: 'cls_math7a', shareWithTeacher: false },  // opted out
    { eventId: 'c', studentId: 'stu_c3d4', shareWithTeacher: true },                          // no class
    { eventId: 'd', studentId: 'stu_c3d4', classId: 'cls_math7b', shareWithTeacher: true },   // another class
    { eventId: 'e', studentId: 'stu_j9k0', classId: 'cls_math7a', shareWithTeacher: true },   // not on this roster
  ]
  assert.deepEqual(eligibleForTeacher(events, mathA).map((event) => event.eventId), ['a'])
})

test('a student on two rosters keeps the two classes apart', () => {
  const mathB = /** @type {import('../shared/access.mjs').ClassRecord} */ (classes.get('cls_math7b'))
  const events = [
    { eventId: 'in-a', studentId: 'stu_a1b2', classId: 'cls_math7a', shareWithTeacher: true },
    { eventId: 'in-b', studentId: 'stu_a1b2', classId: 'cls_math7b', shareWithTeacher: true },
  ]
  assert.deepEqual(eligibleForTeacher(events, mathA).map((event) => event.eventId), ['in-a'])
  assert.deepEqual(eligibleForTeacher(events, mathB).map((event) => event.eventId), ['in-b'])
})

test('narrowing to one student does not widen anything', () => {
  const events = [
    { eventId: 'a', studentId: 'stu_c3d4', classId: 'cls_math7a', shareWithTeacher: true },
    { eventId: 'b', studentId: 'stu_e5f6', classId: 'cls_math7a', shareWithTeacher: true },
  ]
  assert.deepEqual(eligibleForTeacher(events, mathA, { studentId: 'stu_e5f6' }).map((event) => event.eventId), ['b'])
  assert.deepEqual(eligibleForTeacher(events, mathA, { studentId: 'stu_j9k0' }), [])
})
