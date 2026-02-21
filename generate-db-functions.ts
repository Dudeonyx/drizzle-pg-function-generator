#!/usr/bin/env bun
/**
 * PostgreSQL Function Introspection Generator for Drizzle ORM
 *
 * Connects to a PostgreSQL database, discovers all user-defined functions,
 * and generates fully-typed TypeScript helper wrappers that call those
 * functions via Drizzle's `sql` template tag.
 *
 * Usage:
 *   bun scripts/generate-db-functions.ts [options]
 *
 * Options:
 *   --schema <name>    Schema to introspect (default: "public")
 *   --out <path>       Output file path (default: "./drizzle/db-functions.generated.ts")
 *   --connection-url   Override DATABASE_URL (reads .env.local / .env by default)
 */

import { config } from 'dotenv';
import postgres from 'postgres';
import { writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

// ─── Configuration ──────────────────────────────────────────────────────────

config({ path: ['.env.local', '.env'] });

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const SCHEMA = getArg('--schema', 'public');
const OUT_PATH = resolve(getArg('--out', './drizzle/db-functions.generated.ts'));
const CONNECTION_URL = getArg('--connection-url', process.env.DATABASE_URL ?? '');

if (!CONNECTION_URL) {
  console.error('❌ No DATABASE_URL found. Set it in .env.local or pass --connection-url');
  process.exit(1);
}

// ─── PG Type → TS Type Mapping ──────────────────────────────────────────────

/**
 * Maps PostgreSQL data types to their corresponding TypeScript types.
 * Important design decisions:
 * - `numeric`, `decimal`, `bigint` are mapped to \`string\` to prevent floating-point
 *   and 64-bit integer precision loss in JavaScript.
 * - `json` and `jsonb` map to a generic \`Json\` interface generated alongside the functions.
 * - Array types (e.g., \`text[]\`) are handled dynamically in the \`resolveType\` helper.
 */
const PG_TO_TS: Record<string, string> = {
  // Numeric
  smallint: 'number',
  integer: 'number',
  int: 'number',
  int2: 'number',
  int4: 'number',
  int8: 'string', // bigint as string to avoid precision loss
  bigint: 'string',
  serial: 'number',
  bigserial: 'string',
  real: 'number',
  float4: 'number',
  float8: 'number',
  'double precision': 'number',
  numeric: 'string', // avoid floating-point precision loss
  decimal: 'string',
  money: 'string',

  // Boolean
  boolean: 'boolean',
  bool: 'boolean',

  // String
  text: 'string',
  varchar: 'string',
  'character varying': 'string',
  char: 'string',
  character: 'string',
  name: 'string',
  citext: 'string',

  // UUID
  uuid: 'string',

  // Date/Time
  timestamp: 'string',
  'timestamp without time zone': 'string',
  'timestamp with time zone': 'string',
  timestamptz: 'string',
  date: 'string',
  time: 'string',
  'time without time zone': 'string',
  'time with time zone': 'string',
  timetz: 'string',
  interval: 'string',

  // JSON
  json: 'Json',
  jsonb: 'Json',

  // Network
  inet: 'string',
  cidr: 'string',
  macaddr: 'string',

  // Binary
  bytea: 'string',

  // Other
  void: 'void',
  record: 'Record<string, unknown>',
  trigger: '__trigger__', // sentinel, will be filtered out
  oid: 'number',
  regclass: 'string',
  regtype: 'string',
};

// ─── Types ──────────────────────────────────────────────────────────────────

/** Represents a single parameter or OUT column of a PostgreSQL function */
interface PgFunctionParam {
  name: string;
  type: string;
  mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
  hasDefault: boolean;
  enumValues: string[] | null;
}

/** Represents complete metadata for a parsed PostgreSQL function */
interface PgFunctionInfo {
  name: string;
  schema: string;
  params: PgFunctionParam[];
  returnType: string;
  returnsSet: boolean;
  returnTypeIsEnum: boolean;
  returnEnumValues: string[] | null;
  returnColumns: { name: string; type: string; enumValues: string[] | null }[] | null;
  isSecurityDefiner: boolean;
  volatility: string;
  description: string | null;
}

// ─── Introspection Queries ──────────────────────────────────────────────────

/**
 * Core introspection query.
 * Extracts function metadata from pg_proc, pg_type, and pg_namespace.
 * Identifies argument modes (IN/OUT), argument names, and return types.
 * Also fetches enum values for any argument or return type involved.
 */
const INTROSPECT_FUNCTIONS_SQL = `
WITH enum_values AS (
  SELECT
    t.oid AS type_oid,
    t.typname AS type_name,
    n.nspname AS type_schema,
    array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  GROUP BY t.oid, t.typname, n.nspname
)
SELECT
  p.proname AS func_name,
  n.nspname AS func_schema,
  p.pronargs AS num_args,
  p.pronargdefaults AS num_defaults,
  COALESCE(p.proargnames, '{}') AS arg_names,
  COALESCE(p.proargmodes::text[], '{}') AS arg_modes,
  p.proretset AS returns_set,
  -- Argument type OIDs (including OUT params if present)
  COALESCE(p.proallargtypes::oid[], p.proargtypes::oid[]) AS all_arg_type_oids,
  -- Argument type names resolved
  (
    SELECT array_agg(
      CASE
        WHEN t2.typtype = 'e' THEN 'USER_ENUM::' || t2.typname
        ELSE format_type(t2.oid, NULL)
      END
      ORDER BY u.ord
    )
    FROM unnest(COALESCE(p.proallargtypes::oid[], p.proargtypes::oid[])) WITH ORDINALITY AS u(type_oid, ord)
    JOIN pg_type t2 ON t2.oid = u.type_oid
  ) AS arg_type_names,
  -- Return type
  CASE
    WHEN rt.typtype = 'e' THEN 'USER_ENUM::' || rt.typname
    ELSE format_type(rt.oid, NULL)
  END AS return_type,
  rt.typtype AS return_typtype,
  -- Enum values for return type if applicable
  ret_ev.values AS return_enum_values,
  -- Security/volatility  
  p.prosecdef AS is_security_definer,
  p.provolatile AS volatility,
  -- Description
  d.description AS func_description,
  -- Enum values for arguments
  (
    SELECT json_agg(
      json_build_object(
        'ord', u.ord,
        'values', ev2.values
      )
    )
    FROM unnest(COALESCE(p.proallargtypes::oid[], p.proargtypes::oid[])) WITH ORDINALITY AS u(type_oid, ord)
    JOIN pg_type t3 ON t3.oid = u.type_oid
    LEFT JOIN enum_values ev2 ON ev2.type_oid = t3.oid
    WHERE t3.typtype = 'e'
  ) AS arg_enum_values
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_type rt ON rt.oid = p.prorettype
LEFT JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass
LEFT JOIN enum_values ret_ev ON ret_ev.type_oid = rt.oid
WHERE n.nspname = $1
  AND p.prokind = 'f' -- only functions (not procedures/aggregates/window)
  AND rt.typname != 'trigger' -- skip trigger functions
ORDER BY p.proname;
`;

/**
 * Query to resolve the shape of complex record/table returning functions.
 * For functions that RETURN TABLE(...) or SETOF some_table, this extracts
 * the column names and types of the underlying composite representation.
 */
const TABLE_RETURN_COLUMNS_SQL = `
SELECT
  a.attname AS column_name,
  CASE
    WHEN t.typtype = 'e' THEN 'USER_ENUM::' || t.typname
    ELSE format_type(t.oid, a.atttypmod)
  END AS column_type,
  t.typtype,
  (
    SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
    FROM pg_enum e WHERE e.enumtypid = t.oid
  ) AS enum_values
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_type rt ON rt.oid = p.prorettype
JOIN pg_class c ON c.oid = rt.typrelid
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
JOIN pg_type t ON t.oid = a.atttypid
WHERE n.nspname = $1
  AND p.proname = $2
ORDER BY a.attnum;
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Converts snake_case to PascalCase (e.g., 'my_func' -> 'MyFunc') */
function toPascalCase(snakeName: string): string {
  return snakeName
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/** Converts snake_case to camelCase (e.g., 'my_func' -> 'myFunc') */
function toCamelCase(snakeName: string): string {
  const pascal = toPascalCase(snakeName);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Resolves a Postgres type to a TypeScript type string.
 * Automatically translates ENUM options into literal unions, and resolves arrays.
 */
function resolveType(pgType: string, enumValues: string[] | null): string {
  if (pgType.startsWith('USER_ENUM::') && enumValues?.length) {
    return enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ');
  }

  // Handle array types
  if (pgType.endsWith('[]')) {
    const baseType = pgType.slice(0, -2);
    const resolved = PG_TO_TS[baseType.toLowerCase()] ?? 'unknown';
    return `${resolved}[]`;
  }

  return PG_TO_TS[pgType.toLowerCase()] ?? 'unknown';
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Main execution step:
 * 1. Connects to the database and runs the introspection query.
 * 2. Processes raw PG data into an array of \`PgFunctionInfo\` objects.
 * 3. Passes the structured data to the generator and writes the final TS file.
 */
async function main() {
  console.log(`🔍 Introspecting schema "${SCHEMA}" ...`);

  const client = postgres(CONNECTION_URL, { prepare: false, max: 1 });

  try {
    // 1. Fetch all functions
    const rows = await client.unsafe(INTROSPECT_FUNCTIONS_SQL, [SCHEMA]);

    if (rows.length === 0) {
      console.log(`ℹ️  No user-defined functions found in schema "${SCHEMA}".`);
      process.exit(0);
    }

    console.log(`  Found ${rows.length} functions`);

    // 2. Build PgFunctionInfo for each
    const functions: PgFunctionInfo[] = [];

    for (const row of rows) {
      const argNames: string[] = row.arg_names ?? [];
      const argModes: string[] = row.arg_modes ?? [];
      const argTypeNames: string[] = row.arg_type_names ?? [];
      const numArgs: number = row.num_args ?? 0;
      const numDefaults: number = row.num_defaults ?? 0;
      const argEnumMap = new Map<number, string[]>();

      // Build enum lookup for args
      if (row.arg_enum_values) {
        const enumEntries = row.arg_enum_values as { ord: number; values: string[] }[];
        for (const entry of enumEntries) {
          if (entry.values) {
            argEnumMap.set(entry.ord, entry.values);
          }
        }
      }

      // When proargmodes is null, all args are IN
      const hasExplicitModes = argModes.length > 0;
      const totalParams = hasExplicitModes ? argTypeNames.length : numArgs;

      const params: PgFunctionParam[] = [];
      const outColumns: { name: string; type: string; enumValues: string[] | null }[] = [];
      let inParamCount = 0;

      for (let i = 0; i < totalParams; i++) {
        const rawMode = hasExplicitModes ? argModes[i] : 'i';
        const mode =
          rawMode === 'o' || rawMode === 't'
            ? 'OUT'
            : rawMode === 'b'
              ? 'INOUT'
              : rawMode === 'v'
                ? 'VARIADIC'
                : 'IN';

        const paramName = argNames[i] || `arg${i}`;
        const paramType = argTypeNames[i] || 'text';
        const enumVals = argEnumMap.get(i + 1) ?? null; // ordinality is 1-based

        if (mode === 'OUT') {
          outColumns.push({ name: paramName, type: paramType, enumValues: enumVals });
        } else {
          inParamCount++;
          // Parameters with defaults are the LAST N in-params
          const inIndex = inParamCount;
          const firstDefaultIdx = numArgs - numDefaults + 1;
          const hasDefault = inIndex >= firstDefaultIdx;

          params.push({
            name: paramName,
            type: paramType,
            mode: mode as PgFunctionParam['mode'],
            hasDefault,
            enumValues: enumVals,
          });
        }
      }

      // Determine return columns for composite/table-returning functions
      let returnColumns: PgFunctionInfo['returnColumns'] = null;

      if (outColumns.length > 0) {
        // OUT params define the return shape
        returnColumns = outColumns;
      } else if (row.return_typtype === 'c') {
        // Composite return type — query its attributes
        const cols = await client.unsafe(TABLE_RETURN_COLUMNS_SQL, [SCHEMA, row.func_name]);
        if (cols.length > 0) {
          returnColumns = cols.map((c: Record<string, unknown>) => ({
            name: c.column_name as string,
            type: c.column_type as string,
            enumValues: c.enum_values as string[] | null,
          }));
        }
      }

      functions.push({
        name: row.func_name,
        schema: row.func_schema,
        params,
        returnType: row.return_type,
        returnsSet: row.returns_set,
        returnTypeIsEnum: row.return_typtype === 'e',
        returnEnumValues: row.return_enum_values,
        returnColumns,
        isSecurityDefiner: row.is_security_definer,
        volatility: row.volatility,
        description: row.func_description,
      });
    }

    // 3. Generate TypeScript
    const output = generateTypeScript(functions);
    writeFileSync(OUT_PATH, output, 'utf-8');

    const relPath = relative(process.cwd(), OUT_PATH);
    console.log(`✅ Generated ${functions.length} function wrappers → ${relPath}`);
  } finally {
    await client.end();
  }
}

// ─── Code Generation ────────────────────────────────────────────────────────

/**
 * Builds the entire TypeScript file content.
 * Responsible for injecting the preamble (imports, shared types like Json)
 * and iterating through functions to generate individual blocks.
 */
function generateTypeScript(functions: PgFunctionInfo[]): string {
  const lines: string[] = [];

  lines.push(`// AUTO-GENERATED FILE — do not edit manually.`);
  lines.push(`// Regenerate with: bun scripts/generate-db-functions.ts`);
  lines.push(`// Generated at: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`import { sql } from 'drizzle-orm';`);
  lines.push(`import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';`);
  lines.push(``);
  lines.push(`type AnyPgDb = PostgresJsDatabase<Record<string, unknown>>;`);
  lines.push(``);
  lines.push(`export type Json =`);
  lines.push(`  | string`);
  lines.push(`  | number`);
  lines.push(`  | boolean`);
  lines.push(`  | null`);
  lines.push(`  | { [key: string]: Json | undefined }`);
  lines.push(`  | Json[];`);
  lines.push(``);

  // Deduplicate overloaded functions by name
  const grouped = new Map<string, PgFunctionInfo[]>();
  for (const fn of functions) {
    const existing = grouped.get(fn.name) ?? [];
    existing.push(fn);
    grouped.set(fn.name, existing);
  }

  for (const [name, overloads] of grouped) {
    // For overloads, generate separate numbered variants
    if (overloads.length > 1) {
      lines.push(
        `// ── ${name} (${overloads.length} overloads) ${'─'.repeat(Math.max(0, 50 - name.length))}──`,
      );
      lines.push(``);

      for (let i = 0; i < overloads.length; i++) {
        const fn = overloads[i];
        const suffix = `_v${i + 1}`;
        lines.push(...generateFunctionBlock(fn, suffix));
        lines.push(``);
      }
    } else {
      lines.push(`// ── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}──`);
      lines.push(``);
      lines.push(...generateFunctionBlock(overloads[0]));
      lines.push(``);
    }
  }

  return lines.join('\n');
}

/**
 * Generates the TS syntax string block for a single function.
 * This includes the Args type, the Row type (if returning a record),
 * and the actual async Drizzle caller function logic.
 */
function generateFunctionBlock(fn: PgFunctionInfo, nameSuffix = ''): string[] {
  const lines: string[] = [];
  const pascalName = toPascalCase(fn.name) + (nameSuffix ? toPascalCase(nameSuffix) : '');
  const camelName = toCamelCase(fn.name) + (nameSuffix ? toPascalCase(nameSuffix) : '');
  const inParams = fn.params.filter((p) => p.mode !== 'OUT');

  // JSDoc
  if (fn.description || fn.isSecurityDefiner) {
    lines.push(`/**`);
    if (fn.description) {
      lines.push(` * ${fn.description}`);
    }
    if (fn.isSecurityDefiner) {
      lines.push(` * @security SECURITY DEFINER`);
    }
    const volLabel =
      fn.volatility === 'i' ? 'IMMUTABLE' : fn.volatility === 's' ? 'STABLE' : 'VOLATILE';
    lines.push(` * @volatility ${volLabel}`);
    lines.push(` */`);
  }

  // Args interface (if function has parameters)
  const hasArgs = inParams.length > 0;

  if (hasArgs) {
    lines.push(`export type ${pascalName}Args = {`);
    // Put required params first, optional params last
    const required = inParams.filter((p) => !p.hasDefault);
    const optional = inParams.filter((p) => p.hasDefault);
    const seenArgs = new Set<string>();
    for (const param of [...required, ...optional]) {
      if (seenArgs.has(param.name)) continue;
      seenArgs.add(param.name);
      const tsType = resolveType(param.type, param.enumValues);
      const optMark = param.hasDefault ? '?' : '';
      lines.push(`  ${param.name}${optMark}: ${tsType};`);
    }
    lines.push(`}`);
    lines.push(``);
  }

  // Return type
  let returnTsType: string;
  const isVoid = fn.returnType === 'void';

  if (isVoid) {
    returnTsType = '{ [key: string]: never }';
  } else if (fn.returnColumns && fn.returnColumns.length > 0) {
    // Generate a return row interface
    const rowInterfaceName = `${pascalName}Row`;
    lines.push(`export type ${rowInterfaceName} = {`);
    const seenCols = new Set<string>();
    for (const col of fn.returnColumns) {
      if (seenCols.has(col.name)) continue;
      seenCols.add(col.name);
      const tsType = resolveType(col.type, col.enumValues);
      lines.push(`  ${col.name}: ${tsType};`);
    }
    lines.push(`}`);
    lines.push(``);
    returnTsType = rowInterfaceName;
  } else if (fn.returnTypeIsEnum && fn.returnEnumValues?.length) {
    returnTsType = `{ result: ${resolveType(fn.returnType, fn.returnEnumValues)} }`;
  } else {
    const resolved = resolveType(fn.returnType, null);
    returnTsType = `{ result: ${resolved} }`;
  }

  // Use SELECT * FROM for set-returning/table functions, SELECT fn() for scalar
  const usesSelectStar = fn.returnsSet || (fn.returnColumns && fn.returnColumns.length > 0);

  // Function signature
  const argsParam = hasArgs ? `args: ${pascalName}Args` : '';
  const dbParam = `db: T`;
  const paramsList = [dbParam, argsParam].filter(Boolean).join(', ');

  // Construct the sql call
  const sqlArgs = inParams
    .map((p) => {
      const accessor = `args.${p.name}`;
      const isJson = p.type === 'json' || p.type === 'jsonb';

      if (isJson) {
        return `\${${accessor} == undefined ? null : JSON.stringify(${accessor})}::${p.type}`;
      }

      if (p.hasDefault) {
        return `\${${accessor} ?? null}`;
      }
      return `\${${accessor}}`;
    })
    .join(', ');

  const funcCall = `${fn.schema}.${fn.name}(${sqlArgs})`;

  if (usesSelectStar) {
    // Set-returning or table function: SELECT * FROM fn(...)
    // Drizzle requires Record<string, unknown> for execute, so we use an intersection
    lines.push(`export async function ${camelName}<T extends AnyPgDb>(${paramsList}) {`);
    if (fn.returnsSet) {
      lines.push(`  return db.execute<${returnTsType}>(sql\`SELECT * FROM ${funcCall}\`);`);
    } else {
      lines.push(
        `  const result = await db.execute<${returnTsType}>(sql\`SELECT * FROM ${funcCall}\`);`,
      );
      lines.push(`  return result[0];`);
    }
    lines.push(`}`);
  } else if (isVoid) {
    // Scalar void function
    lines.push(`export async function ${camelName}<T extends AnyPgDb>(${paramsList}) {`);
    lines.push(`  await db.execute<{ [key: string]: never }>(sql\`SELECT ${funcCall}\`);`);
    lines.push(`}`);
  } else {
    // Scalar function: SELECT fn(...) AS result
    lines.push(`export async function ${camelName}<T extends AnyPgDb>(${paramsList}) {`);
    lines.push(
      `  const result = await db.execute<${returnTsType}>(sql\`SELECT ${funcCall} AS result\`);`,
    );
    if (fn.returnsSet) {
      lines.push(`  return result.map((r) => r.result);`);
    } else {
      lines.push(`  return result[0]?.result;`);
    }
    lines.push(`}`);
  }

  return lines;
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('❌ Generator failed:', err);
  process.exit(1);
});
