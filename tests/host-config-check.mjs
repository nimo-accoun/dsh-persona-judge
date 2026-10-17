/**
 * Reproduce the host's own activation-time config path exactly:
 *
 *   cordis/lib/index.js
 *     function resolveConfig(runtime, config) {
 *       if (!runtime.Config) return config
 *       const result = runtime.Config['~standard'].validate(config)
 *       if ('then' in result) throw new TypeError('Async config validation is not supported')
 *       if (result.issues) throw new ValidationError(result.issues)
 *       else return result.value
 *     }
 *
 * Run this to see the real error before the host does.
 */
import * as plugin from '../lib/index.js'

function resolveConfig(runtime, config) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) {
    const error = new Error(`ValidationError: ${JSON.stringify(result.issues)}`)
    error.name = 'ValidationError'
    throw error
  }
  return result.value
}

console.log('module exports  :', Object.keys(plugin).sort().join(', '))
console.log('has apply       :', typeof plugin.apply)
console.log('inject          :', JSON.stringify(plugin.inject))
console.log('Config present  :', plugin.Config !== undefined, '| ~standard:', typeof plugin.Config?.['~standard'])

for (const raw of [{}, undefined, { passScore: 90 }, { judge: 'manual' }, { enabled: false }]) {
  try {
    const resolved = resolveConfig(plugin, raw)
    console.log(`OK  raw=${JSON.stringify(raw)} -> judge=${resolved.judge} passScore=${resolved.passScore} enabled=${resolved.enabled}`)
  } catch (error) {
    console.log(`ERR raw=${JSON.stringify(raw)} -> ${error.name}: ${error.message}`)
  }
}

// The other thing the host does with Config before apply: project its JSON
// Schema for the settings page. An incompatible toJSON would fail separately.
try {
  const projected = JSON.parse(JSON.stringify(plugin.Config))
  console.log('toJSON projectable:', Object.keys(projected))
} catch (error) {
  console.log('toJSON FAILED:', error.message)
}
