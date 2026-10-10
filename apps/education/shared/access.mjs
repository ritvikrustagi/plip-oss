/**
 * Who may see what.
 *
 * Two rules decide every teacher-facing byte:
 *   1. authorized class membership - the teacher must teach the class, and the
 *      student must be on that class's roster;
 *   2. eligible opt-in - the event itself must say shareWithTeacher.
 *
 * Both are checked here, in one place, by the demo API on every request. This
 * module is the demo's stand-in for a school's real roster and directory; see
 * docs/CHROMEBOOK.md for what production has to provide instead.
 */

/**
 * @typedef {{
 *   id: string, role: 'student' | 'teacher', displayName: string,
 *   studentId?: string, teacherId?: string, classIds: string[],
 * }} Identity
 * @typedef {{ classId: string, name: string, teacherIds: string[], studentIds: string[], plannedConceptIds: string[], joinCode: string }} ClassRecord
 */

/**
 * Classes come from a Map in the demo and from a database lookup in
 * production. Both arrive here as something that can answer "is there a class
 * with this id?", and the rules below do not care which.
 * @typedef {Map<string, ClassRecord> | Record<string, ClassRecord> | ((classId: string) => ClassRecord | null | undefined)} ClassLookup
 * @param {ClassLookup} classes @param {string} classId @returns {ClassRecord | undefined}
 */
function findClass(classes, classId) {
  if (typeof classes === 'function') return classes(classId) ?? undefined
  if (classes instanceof Map) return classes.get(classId)
  return classes[classId]
}

export class AccessError extends Error {
  /** @param {number} status @param {string} message @param {string} code */
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** @param {Identity | null | undefined} identity @returns {Identity} */
export function requireIdentity(identity) {
  if (!identity) throw new AccessError(401, 'This demo needs a demo token.', 'no_identity')
  return identity
}

/** @param {Identity | null | undefined} identity @param {'student' | 'teacher'} role */
export function requireRole(identity, role) {
  const who = requireIdentity(identity)
  if (who.role !== role) throw new AccessError(403, `Only a ${role} may do that.`, 'wrong_role')
  return who
}

/**
 * A teacher reading a class: they must teach it, and it must exist.
 * @param {Identity | null | undefined} identity
 * @param {string} classId
 * @param {ClassLookup} classes
 * @returns {{ identity: Identity, klass: ClassRecord }}
 */
export function authorizeTeacherClass(identity, classId, classes) {
  const teacher = requireRole(identity, 'teacher')
  const klass = findClass(classes, classId)
  // Same answer whether the class is missing or simply not theirs: a 404 that
  // only appears for other teachers' classes is itself a roster leak.
  if (!klass || !teacher.classIds.includes(classId) || !klass.teacherIds.includes(teacher.teacherId ?? ''))
    throw new AccessError(403, 'That class is not yours.', 'class_not_authorized')
  return { identity: teacher, klass }
}

/**
 * A teacher reading one student: the student must be on that class's roster.
 * @param {ClassRecord} klass
 * @param {string} studentId
 */
export function authorizeRosterMember(klass, studentId) {
  if (!klass.studentIds.includes(studentId))
    throw new AccessError(403, 'That student is not on this class roster.', 'not_on_roster')
  return studentId
}

/**
 * A student writing an event or reading their own data.
 * @param {Identity | null | undefined} identity
 * @param {string} studentId
 */
export function authorizeStudentSelf(identity, studentId) {
  const student = requireRole(identity, 'student')
  if (!student.studentId || student.studentId !== studentId)
    throw new AccessError(403, 'A student may only touch their own work.', 'not_own_data')
  return student
}

/**
 * May this student attach this event to this class? Only classes they are
 * enrolled in, and only ones whose roster still lists them.
 * @param {Identity} student
 * @param {string} classId
 * @param {ClassLookup} classes
 */
export function authorizeStudentClass(student, classId, classes) {
  const klass = findClass(classes, classId)
  if (!klass || !student.classIds.includes(classId) || !klass.studentIds.includes(student.studentId ?? ''))
    throw new AccessError(403, 'You are not in that class.', 'class_not_joined')
  return klass
}

/**
 * The only events a teacher summary may ever be built from: shared on purpose,
 * attached to this class, by a student the roster actually lists.
 * @template {{ studentId: string, classId?: string, shareWithTeacher: boolean }} E
 * @param {E[]} events
 * @param {ClassRecord} klass
 * @param {{ studentId?: string }} [scope] narrow to one roster member
 * @returns {E[]}
 */
export function eligibleForTeacher(events, klass, scope = {}) {
  const roster = new Set(klass.studentIds)
  return events.filter((event) =>
    event.shareWithTeacher === true &&
    event.classId === klass.classId &&
    roster.has(event.studentId) &&
    (scope.studentId === undefined || event.studentId === scope.studentId))
}
