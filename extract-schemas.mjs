// extract-schemas.mjs — read src/content.config.ts and produce a JSON form-spec.
//
// STATUS: Aspirational. content.config.ts imports `astro:content`, which is a
// virtual module only resolvable inside Astro's build. Running this script
// directly will fail at the import line.
//
// To make this live, you'd need either (a) a Node loader that stubs
// astro:content into `{ defineCollection: c => c, z: <real zod>, reference: () => z.string() }`,
// or (b) a TypeScript AST walker that reads content.config.ts as text and
// extracts the Zod calls without executing them.
//
// For now, schemas.json next to this file is the source of truth — regenerate
// it by hand when content.config.ts changes. The structure below is what an
// automated extractor should emit, kept in case the import problem is solved
// (e.g. Astro 7 exposes the schemas as JSON, or we wire up a loader hook).

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG = resolve('src/content.config.ts');
const OUT    = resolve('tools/edit/schemas.json');

// Run with `node --import tsx tools/edit/extract-schemas.mjs` so TS imports work.
const mod = await import(pathToFileURL(CONFIG).href);
const collections = mod.collections ?? {};

const out = {};
for (const [name, def] of Object.entries(collections)) {
  // Astro wraps the schema; inside it's a Zod object schema.
  const schema = def?._def?.schema ?? def?.schema;
  if (!schema?._def?.shape) {
    console.warn(`skip ${name}: no shape`);
    continue;
  }
  out[name] = walkObject(schema);
}

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT} — ${Object.keys(out).length} collections`);

// ── Zod walker ──────────────────────────────────────────────────────────────

function walkObject(schema) {
  const fields = [];
  const shape = typeof schema._def.shape === 'function'
    ? schema._def.shape()
    : schema._def.shape;
  for (const [key, value] of Object.entries(shape)) {
    fields.push(walkField(key, value));
  }
  return fields;
}

function walkField(name, schema) {
  // Unwrap optional / default / coerce wrappers, remembering what we found.
  let optional = false;
  let defaultValue;
  let s = schema;
  while (true) {
    const t = s._def.typeName;
    if (t === 'ZodOptional') { optional = true; s = s._def.innerType; continue; }
    if (t === 'ZodDefault')  { defaultValue = s._def.defaultValue(); s = s._def.innerType; continue; }
    if (t === 'ZodEffects')  { s = s._def.schema; continue; }
    break;
  }

  const t = s._def.typeName;

  if (t === 'ZodString')  return { name, kind: 'string',  required: !optional, default: defaultValue };
  if (t === 'ZodNumber')  return { name, kind: 'number',  required: !optional, default: defaultValue };
  if (t === 'ZodBoolean') return { name, kind: 'boolean', required: !optional, default: defaultValue };
  if (t === 'ZodDate')    return { name, kind: 'date',    required: !optional, default: defaultValue };

  if (t === 'ZodEnum') {
    return { name, kind: 'enum', required: !optional, options: s._def.values, default: defaultValue };
  }
  if (t === 'ZodArray') {
    const inner = walkField(`${name}[]`, s._def.type);
    return { name, kind: 'array', required: !optional, of: inner };
  }
  if (t === 'ZodObject') {
    return { name, kind: 'object', required: !optional, fields: walkObject(s) };
  }

  return { name, kind: 'unknown', required: !optional, raw: t };
}
