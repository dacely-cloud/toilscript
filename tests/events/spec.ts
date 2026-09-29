@data
class Key {
  id: string = "stream";
}

@data
class Event {
  value: i32 = 42;
}

@database
class DB {
  @collection static events: Events<Key, Event>;
}

@action
export function seed(): void {
  DB.events.appendOnce(new Key(), "revision:6", new Event());
}

@query
export function get(): i32 {
  const event = DB.events.get(new Key(), "revision:6");
  return event == null ? -1 : event.value;
}

@query
export function last(): i32 {
  const event = DB.events.last(new Key());
  return event == null ? -1 : event.value;
}

export function error(): i32 {
  return <i32>Db.lastError();
}
