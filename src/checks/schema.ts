/**
 * A small, strict JSON Schema validator for output gates.
 *
 * Supports the keywords structured-output APIs use: type (including type
 * lists), enum, const, properties, required, additionalProperties, items,
 * minItems, maxItems, minLength, maxLength, pattern, minimum, maximum and
 * anyOf. Unknown keywords are ignored, so pass the same schema your app sends
 * to the model. A gate fails on any error: an output that breaks the protocol
 * is unusable however good its text reads.
 */

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  [keyword: string]: unknown;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

/** Every violation, as `<json pointer>: <problem>`; empty when the value conforms. */
export function validateSchema(value: unknown, schema: JsonSchema, path = ''): string[] {
  const at = path || '/';
  const errors: string[] = [];

  if (schema.anyOf) {
    const branches = schema.anyOf.map((branch) => validateSchema(value, branch, path));
    if (!branches.some((branch) => branch.length === 0)) errors.push(`${at}: matches none of anyOf (${branches.map((branch) => branch[0]).join('; ')})`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items!, `${path}/${index}`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}/${key}: required property missing`);
    }
    for (const [key, inner] of Object.entries(record)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        errors.push(...validateSchema(inner, propertySchema, `${path}/${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}/${key}: additional property not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateSchema(inner, schema.additionalProperties, `${path}/${key}`));
      }
    }
  }
  return errors;
}

/** Parses string output as JSON (unwrapping a ```json fence) so it can be validated. */
export function parseJsonOutput(output: unknown): { value: unknown; error?: string } {
  if (typeof output !== 'string') return { value: output };
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return { value: JSON.parse(fenced ? fenced[1] : trimmed) };
  } catch (error) {
    return { value: undefined, error: `output is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}
