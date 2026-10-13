@data class Key { id: i32 = 1; }
@data class Value { count: i32 = 42; }
@database class DB { @collection static events: Events<Key,Value>; }
// @ts-ignore
@action export function seed(): void { DB.events.appendOnce(new Key(),'one',new Value()); }
// @ts-ignore
@action export function erase(): bool {
  const reference = DB.events.reference(new Key(),'one');
  return reference != null && DB.events.redact(new Key(),reference);
}
// @ts-ignore
@job export function page(): i32 {
  const page = DB.events.entries(new Key(), 8);
  return page.entries.length == 0 ? 0 : page.entries[0].value.count;
}
