/**
 * A very small JSON Schema checker: just the keywords
 * contracts/learning-event.schema.json actually uses.
 *
 * Why not a library: the contract is the single source of truth and it has to be
 * enforced in three places (this app's client, this app's demo API, and anything
 * else that learns to emit events). A ~100-line checker that reads the contract
 * file directly can never drift from it, has no supply chain, and runs unchanged
 * in a browser, in Node, and in a Chromebook's service worker.
 *
 * Supported: type, const, enum, required, properties, additionalProperties,
 * items, minItems, maxItems, uniqueItems, pattern, not, minimum, maximum,
 * allOf, if/then. Anything else in a schema is ignored, so do not reach for a
 * keyword this file does not implement without adding it here first.
 */

/** @typedef {{ ok: boolean, errors: string[] }} CheckResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** @param {unknown} value @param {string} type */
function matchesType(value, type) {
  switch (type) {
    case 'object': return isObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'null': return value === null
    default: return true
  }
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Does `value` satisfy `schema`? Errors name the failing path, e.g. "evidence.hintCount".
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {string} [path]
 * @returns {CheckResult}
 */
export function check(value, schema, path = '') {
  /** @type {string[]} */
  const errors = []
  const at = path || 'event'

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${at}: expected ${types.join(' or ')}`)
      return { ok: false, errors }          // nothing below will make sense
    }
  }
  if (schema.const !== undefined && !same(value, schema.const)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value)))
    errors.push(`${at}: must be one of ${schema.enum.join(', ')}`)

  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value))
    errors.push(`${at}: does not match ${schema.pattern}`)
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be at most ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: allows at most ${schema.maxItems} items`)
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)
      errors.push(`${at}: items must be unique`)
    if (schema.items) value.forEach((item, index) => errors.push(...check(item, schema.items, `${at}[${index}]`).errors))
  }
  if (isObject(value)) {
    // Object.hasOwn, not `in`: `in` walks the prototype chain, so a field
    // named toString, constructor or __proto__ would sail through
    // additionalProperties: false - and that rule is the whole reason
    // screenshots and transcripts cannot get into an event.
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}: ${key} is required`)
    const properties = schema.properties ?? {}
    for (const [key, subschema] of Object.entries(properties))
      if (Object.hasOwn(value, key)) errors.push(...check(value[key], subschema, path ? `${path}.${key}` : key).errors)
    if (schema.additionalProperties === false)
      for (const key of Object.keys(value))
        if (!Object.hasOwn(properties, key)) errors.push(`${at}: ${key} is not part of this contract`)
  }

  if (schema.not && check(value, schema.not, path).ok) errors.push(`${at}: must not match ${JSON.stringify(schema.not)}`)
  for (const subschema of schema.allOf ?? []) errors.push(...check(value, subschema, path).errors)
  if (schema.if && check(value, schema.if, path).ok && schema.then) errors.push(...check(value, schema.then, path).errors)
  if (schema.if && !check(value, schema.if, path).ok && schema.else) errors.push(...check(value, schema.else, path).errors)

  return { ok: errors.length === 0, errors }
}
