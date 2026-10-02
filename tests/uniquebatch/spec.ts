@data
class Key { id: string = "key"; }
@data
class Value { value: i32 = 42; }
@database
class DB { @collection static claims: Unique<Key, Value>; }
@action
export function seed(): void { DB.claims.claim(new Key(), new Value()); }
@query
export function read(): i32 {
  const missing = new Key(); missing.id = "absent";
  const values = DB.claims.lookupMany([new Key(), missing, new Key()]);
  assert(values.length == 3 && values[1] == null);
  return values[0]!.value + values[2]!.value;
}
