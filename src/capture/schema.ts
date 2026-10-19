// Inférence de schéma à partir des réponses JSON observées, puis brouillon de modèle Prisma.

type Prim = 'string' | 'integer' | 'number' | 'boolean' | 'null';

export interface Shape {
  types: Set<Prim | 'object' | 'array'>;
  seen: number;
  props?: Map<string, Shape>;
  propSeen?: Map<string, number>;
  items?: Shape;
  strings?: Map<string, number>;
  formats?: Set<string>;
}

const FORMAT_TESTS: [string, RegExp][] = [
  ['date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
  ['date', /^\d{4}-\d{2}-\d{2}$/],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['email', /^[^@\s]+@[^@\s]+\.[^@\s]+$/],
  ['uri', /^https?:\/\//],
  ['color', /^#[0-9a-f]{3,8}$/i],
];

export const emptyShape = (): Shape => ({ types: new Set(), seen: 0 });

export function observe(shape: Shape, value: unknown): Shape {
  shape.seen++;
  if (value === null || value === undefined) {
    shape.types.add('null');
  } else if (Array.isArray(value)) {
    shape.types.add('array');
    shape.items ??= emptyShape();
    for (const v of value) observe(shape.items, v);
  } else if (typeof value === 'object') {
    shape.types.add('object');
    shape.props ??= new Map();
    shape.propSeen ??= new Map();
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$')) continue; // métadonnées d'API ($schema…), pas des champs métier
      if (!shape.props.has(k)) shape.props.set(k, emptyShape());
      observe(shape.props.get(k)!, v);
      shape.propSeen.set(k, (shape.propSeen.get(k) ?? 0) + 1);
    }
  } else if (typeof value === 'number') {
    shape.types.add(Number.isInteger(value) ? 'integer' : 'number');
  } else if (typeof value === 'boolean') {
    shape.types.add('boolean');
  } else {
    const s = String(value);
    shape.types.add('string');
    shape.strings ??= new Map();
    if (shape.strings.size < 50) shape.strings.set(s, (shape.strings.get(s) ?? 0) + 1);
    shape.formats ??= new Set(FORMAT_TESTS.map(([f]) => f));
    for (const [f, re] of FORMAT_TESTS) if (!re.test(s)) shape.formats.delete(f);
  }
  return shape;
}

/** Fusionne une forme dans une autre (pour regrouper par entité). */
export function mergeInto(target: Shape, src: Shape): Shape {
  target.seen += src.seen;
  src.types.forEach((t) => target.types.add(t));
  if (src.items) target.items = mergeInto(target.items ?? emptyShape(), src.items);
  if (src.props) {
    target.props ??= new Map();
    target.propSeen ??= new Map();
    for (const [k, s] of src.props) {
      target.props.set(k, mergeInto(target.props.get(k) ?? emptyShape(), s));
      target.propSeen.set(k, (target.propSeen.get(k) ?? 0) + (src.propSeen?.get(k) ?? 0));
    }
  }
  if (src.strings) {
    target.strings ??= new Map();
    for (const [s, n] of src.strings) target.strings.set(s, (target.strings.get(s) ?? 0) + n);
  }
  if (src.formats) {
    target.formats = target.formats ? new Set([...target.formats].filter((f) => src.formats!.has(f))) : new Set(src.formats);
  }
  return target;
}

const objectCount = (s: Shape) => (s.propSeen ? Math.max(0, ...s.propSeen.values()) : 0);

/** Petit ensemble de valeurs "jetons" (sans espace) très récurrentes → enum probable. */
function enumValues(s: Shape, field = ''): string[] | undefined {
  if (!s.strings || s.formats?.size || /(^id$|Id$|_id$)/.test(field)) return undefined;
  const values = [...s.strings.keys()];
  if (!values.every((v) => /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(v))) return undefined;
  const total = [...s.strings.values()].reduce((a, b) => a + b, 0);
  if (values.length >= 2 && values.length <= 8 && total >= values.length * 3) return values.sort();
  return undefined;
}

export function toJsonSchema(s: Shape, field = ''): Record<string, unknown> {
  const types = [...s.types];
  const out: Record<string, unknown> = { type: types.length === 1 ? types[0] : types };
  if (s.props) {
    const n = objectCount(s);
    out.properties = Object.fromEntries([...s.props].map(([k, v]) => [k, toJsonSchema(v, k)]));
    out.required = [...s.props.keys()].filter((k) => s.propSeen!.get(k) === n);
  }
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.formats?.size) out.format = [...s.formats][0];
  const e = enumValues(s, field);
  if (e) out.enum = e;
  return out;
}

// ---------- Entités & Prisma ----------

const pascal = (s: string) => s.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase());
const singular = (s: string) => s.replace(/ies$/, 'y').replace(/(s|x|ch|sh)es$/, '$1').replace(/s$/, '');

/** /api/projects/:id/tasks → "Task" ; /api/projects/:id → "Project". */
export function entityFromTemplate(template: string): string | undefined {
  const segs = template.split('/').filter((s) => s && s !== ':id' && !/^(api|v\d+)$/.test(s));
  const last = segs.at(-1);
  return last ? pascal(singular(last)) : undefined;
}

/** Forme d'un élément de l'entité (déballe les listes et les enveloppes {data: [...]}). */
export function entityShape(body: Shape): Shape | undefined {
  if (body.items?.props) return body.items;
  if (body.props?.has('id')) return body;
  for (const key of ['data', 'items', 'results', 'records']) {
    const inner = body.props?.get(key);
    if (inner?.items?.props) return inner.items;
  }
  return undefined;
}

function prismaType(field: string, s: Shape, enums: Map<string, string[]>, model: string): string {
  const t = [...s.types].filter((x) => x !== 'null');
  const e = enumValues(s, field);
  if (e && t.length === 1 && t[0] === 'string') {
    const name = model + pascal(field);
    enums.set(name, e);
    return name;
  }
  if (t.length !== 1) return 'Json';
  switch (t[0]) {
    case 'string': return s.formats?.has('date-time') || s.formats?.has('date') ? 'DateTime' : 'String';
    case 'integer': return 'Int';
    case 'number': return 'Float';
    case 'boolean': return 'Boolean';
    default: return 'Json';
  }
}

export function toPrisma(entities: Map<string, Shape>): string {
  const enums = new Map<string, string[]>();
  const backRefs = new Map<string, string[]>();
  const models: string[] = [];

  for (const [model, s] of entities) {
    const n = objectCount(s);
    const lines: string[] = [];
    for (const [field, fs] of s.props ?? []) {
      const optional = s.propSeen!.get(field) !== n || fs.types.has('null');
      if (field === 'id') {
        lines.push(`  id ${fs.types.has('integer') ? 'Int @id @default(autoincrement())' : 'String @id @default(cuid())'}`);
        continue;
      }
      const relation = field.match(/^(\w+?)(?:Id|_id)$/);
      const target = relation && pascal(relation[1]);
      const type = prismaType(field, fs, enums, model);
      const notes = [
        enums.has(type) && 'enum probable, valeurs observées à confirmer',
        optional && !fs.types.has('null') && 'absent de certaines réponses',
      ].filter(Boolean);
      lines.push(`  ${field} ${type}${optional ? '?' : ''}${notes.length ? ` // ${notes.join(' ; ')}` : ''}`);
      if (target && entities.has(target)) {
        lines.push(`  ${relation![1]} ${target}${optional ? '?' : ''} @relation(fields: [${field}], references: [id])`);
        backRefs.set(target, [...(backRefs.get(target) ?? []), `  ${model.charAt(0).toLowerCase() + model.slice(1)}s ${model}[]`]);
      }
    }
    models.push(`model ${model} {\n${lines.join('\n')}\n__BACKREFS_${model}__}`);
  }

  const body = models
    .map((m) => m.replace(/__BACKREFS_(\w+)__/, (_, name) => (backRefs.get(name) ?? []).map((l) => l + '\n').join('')))
    .join('\n\n');
  const enumBlocks = [...enums].map(([name, vals]) => `enum ${name} {\n${vals.map((v) => `  ${v.replace(/\W/g, '_')}`).join('\n')}\n}`);
  return [
    '// Brouillon généré depuis le trafic observé — à relire, pas à appliquer tel quel.',
    'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}',
    ...enumBlocks,
    body,
  ].join('\n\n') + '\n';
}
