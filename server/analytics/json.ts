// The analytics service is a standalone Node package; this is its single guard for
// untrusted JSON objects (request bodies and backup files). Callers still check each field.
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
