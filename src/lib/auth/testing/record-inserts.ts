// Test helper: wraps a Drizzle database or transaction so the keys of every
// insert(...).values(...) are recorded, by table name. Used to prove that
// Better Auth leaves primary keys to PostgreSQL (it sends no id, and reads
// the generated one back with RETURNING). Everything else is passed through
// to the wrapped object unchanged. Never imported by application code.
import { getTableName, type Table } from "drizzle-orm";

export type RecordedInsert = { table: string; keys: string[] };

type Inserter = { insert: (table: Table) => object };

// Reads a property from the wrapped object itself, binding methods to it.
function forward(object: object, property: string | symbol): unknown {
  const value = Reflect.get(object, property, object) as unknown;
  return typeof value === "function" ? value.bind(object) : value;
}

export function recordInserts<T extends Inserter>(db: T) {
  const inserts: RecordedInsert[] = [];
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property !== "insert") return forward(target, property);
      return (table: Table) => {
        const builder = target.insert(table);
        return new Proxy(builder, {
          get(object, name) {
            if (name !== "values") return forward(object, name);
            return (
              values: Record<string, unknown> | Record<string, unknown>[],
            ) => {
              for (const row of [values].flat()) {
                inserts.push({
                  table: getTableName(table),
                  keys: Object.keys(row).filter(
                    (key) => row[key] !== undefined,
                  ),
                });
              }
              return (object as { values: (v: unknown) => unknown }).values(
                values,
              );
            };
          },
        });
      };
    },
  });
  return { db: wrapped, inserts };
}
