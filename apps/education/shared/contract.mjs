/**
 * The learning event contract, loaded from the file both the client and the
 * demo API validate against: contracts/learning-event.schema.json.
 *
 * Import attributes keep one copy of the contract for every runtime that needs
 * it (Node for the demo API and the tests, the bundler for the PWA).
 */
import schema from '../../../contracts/learning-event.schema.json' with { type: 'json' }

export const LEARNING_EVENT_SCHEMA = /** @type {Record<string, any>} */ (schema)
export const SCHEMA_VERSION = 1

const enumOf = (/** @type {string} */ name) =>
  /** @type {string[]} */ (LEARNING_EVENT_SCHEMA.properties[name].enum)

export const PLATFORMS = enumOf('platform')
export const EVENT_TYPES = enumOf('type')
export const OUTCOMES = /** @type {string[]} */ (LEARNING_EVENT_SCHEMA.properties.evidence.properties.outcome.enum)
export const EVIDENCE_KEYS = Object.keys(LEARNING_EVENT_SCHEMA.properties.evidence.properties)
export const EVENT_FIELDS = Object.keys(LEARNING_EVENT_SCHEMA.properties)
