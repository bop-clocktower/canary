// canary-cry schema helpers shared by the flows and targets validators
// (schema.mjs, schema-targets.mjs). Every error is `<json path>: <problem>`.
// Unknown keys are errors; a `"//"` key is the family's comment convention
// (canary-shadow's example file) and is allowed in any object.

import fs from 'node:fs';

// Ids feed scenario ids `<flow>:<pattern>:i<n>:s<step>`, so ':' is never legal.
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isText = (v) => typeof v === 'string' && v.trim() !== '';
export const declared = (obj) => Object.keys(obj).filter((k) => k !== '//');

/** `$.a`, `$.a[0]`, or `$.a["two words"]`. */
export function at(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  if (PLAIN_KEY.test(key)) return `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

export function unknownKeys(obj, allowed, path, errors) {
  for (const key of declared(obj)) {
    if (!allowed.includes(key)) errors.push(`${at(path, key)}: unknown key`);
  }
}

export function needObject(value, path, errors) {
  if (isObj(value)) return true;
  errors.push(`${path}: must be an object`);
  return false;
}

export function needText(value, path, errors) {
  if (isText(value)) return true;
  errors.push(`${path}: must be a non-empty string`);
  return false;
}

export function needId(value, path, seen, errors) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    errors.push(`${path}: must match ${ID_RE}`);
    return;
  }
  if (seen.has(value)) errors.push(`${path}: duplicate id '${value}'`);
  seen.add(value);
}

/** Visit each item of an array, or report the array itself. */
export function eachItem(list, path, errors, required, visit) {
  if (list === undefined && !required) return;
  if (!Array.isArray(list) || (required && list.length === 0)) {
    const shape = required ? 'a non-empty array' : 'an array';
    errors.push(`${path}: must be ${shape}`);
    return;
  }
  list.forEach((item, i) => visit(item, at(path, i)));
}

/** Read and parse a JSON input: `{doc}` or `{error}`. Never throws. */
export function readJsonFile(file, label) {
  if (!fs.existsSync(file))
    return { error: `${label} file not found: ${file}` };
  try {
    return { doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (exc) {
    return {
      error: `${label} file is not valid JSON: ${file}: ${exc.message}`,
    };
  }
}
