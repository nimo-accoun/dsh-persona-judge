/**
 * The Config export must satisfy the host's exact contract, which is the
 * Standard Schema interface — the host calls
 * `Config['~standard'].validate(raw)` and throws a TypeError if that is not a
 * function. A bare field map (the first attempt) failed activation with
 * "Cannot read properties of undefined (reading 'validate')".
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Config } from '../lib/index.js'

test('Config implements the Standard Schema interface the host calls', () => {
  assert.equal(typeof Config, 'object')
  const standard = Config['~standard']
  assert.ok(standard, "Config['~standard'] must exist")
  assert.equal(standard.version, 1)
  assert.equal(typeof standard.validate, 'function')
  assert.equal(standard.vendor, 'dsh-persona-judge')
})

test('validate(raw) returns a synchronous result object, never a promise', () => {
  const result = Config['~standard'].validate({ passScore: 70 })
  assert.ok(result && typeof result === 'object')
  assert.equal('then' in result, false, 'async validation is rejected by the host')
  assert.equal(result.issues, undefined)
})

test('validate fills every default and keeps supplied values', () => {
  const { value } = Config['~standard'].validate({ passScore: 70, askOnPass: false })
  assert.equal(value.passScore, 70)
  assert.equal(value.askOnPass, false)
  assert.equal(value.enabled, true)
  assert.equal(value.judge, 'turn')
  assert.equal(value.model, '')
  assert.equal(value.injectOrder, -50)
  // every declared field is present, with no extras
  assert.deepEqual(
    Object.keys(value).sort(),
    Object.keys(Config.toJSON().properties).sort(),
  )
})

test('validate clamps numbers instead of rejecting out-of-range ones', () => {
  const { value } = Config['~standard'].validate({ passScore: 999, injectOrder: -9999 })
  assert.equal(value.passScore, 100)
  assert.equal(value.injectOrder, -1000)
})

test('validate reports an issue for a non-numeric number field', () => {
  const result = Config['~standard'].validate({ passScore: 'not a number' })
  assert.ok(Array.isArray(result.issues))
  assert.equal(result.issues.length, 1)
  assert.deepEqual(result.issues[0].path, ['passScore'])
  assert.equal(result.value, undefined)
})

test('validate reports an issue for a value outside an enum', () => {
  const result = Config['~standard'].validate({ judge: 'sometimes' })
  assert.ok(Array.isArray(result.issues))
  assert.deepEqual(result.issues[0].path, ['judge'])
})

test('toJSON is a usable JSON Schema for the settings surface', () => {
  const schema = Config.toJSON()
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.passScore.type, 'number')
  assert.equal(schema.properties.passScore.minimum, 0)
  assert.deepEqual(schema.properties.judge.enum, ['turn', 'manual'])
  assert.equal(schema.properties.enabled.default, true)
  // the projected schema must itself survive a round trip
  assert.ok(JSON.stringify(schema).length > 100)
})

test('an empty or absent input still yields a complete config', () => {
  for (const input of [undefined, null, {}, 'nonsense', 42]) {
    const { value } = Config['~standard'].validate(input)
    assert.equal(value.enabled, true)
    assert.equal(value.passScore, 80)
  }
})

/**
 * The settings service (@deepseek-ai/dsh-settings) reads every configurable
 * entry as a Schemastery node, not as a Standard Schema: `describe()` reads
 * `schema.meta.volatile` before it looks at anything else. A Config carrying
 * only `~standard` threw "Cannot read properties of undefined (reading
 * 'volatile')" there, which failed `settings/describe` and with it the desktop
 * welcome screen — the app would not open at all.
 */
test('Config carries the Schemastery metadata the settings service reads', () => {
  assert.equal(Config.type, 'object')
  assert.ok(Config.meta && typeof Config.meta === 'object', 'meta must be an object')
  assert.equal(Boolean(Config.meta.volatile), false)
  assert.ok(Config.dict && typeof Config.dict === 'object', 'dict must be an object')
  assert.deepEqual(Object.keys(Config.dict).sort(), Object.keys(Config.toJSON().properties).sort())
  for (const [key, node] of Object.entries(Config.dict)) {
    assert.ok(node.meta && typeof node.meta === 'object', `${key} needs a meta object`)
    assert.equal(Boolean(node.meta.volatile), false)
  }
})

test('the settings form walk stays empty instead of throwing', () => {
  // Mirrors @deepseek-ai/dsh-settings volatileForm(): it reads meta.volatile on
  // the entry and one level down, and returns undefined when no field is live.
  const volatileForm = (schema) => {
    if (schema.meta.volatile) return schema
    if (schema.type !== 'object') return undefined
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : dict
  }
  assert.equal(volatileForm(Config), undefined)
})
