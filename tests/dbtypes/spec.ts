@data
class Key {
    id: string = "one";
}

@data
class Value {
    text: string = "updated";
}

@database
class Records {
    @collection static items: Documents<Key, Value>;
}

// @ts-ignore: ToilScript permits decorators on free functions.
@action
export function queue(): bool {
    const accepted: bool = Records.items.enqueue(new Key(), new Value());
    return accepted;
}

// @ts-ignore
@action
export function seed(): bool { return Records.items.create(new Key(), new Value()); }

// @ts-ignore
@action
export function replaceObserved(): bool {
    const observed = Records.items.getCurrentSnapshot(new Key());
    if (observed == null) return false;
    observed.value.text = "replacement";
    return Records.items.compareExchangeSnapshot(new Key(), observed, observed.value);
}

// @ts-ignore
@action
export function deleteObserved(): bool {
    const observed = Records.items.getSnapshot(new Key());
    return observed == null ? false : Records.items.compareDeleteSnapshot(new Key(), observed);
}

// @ts-ignore
@action
export function deleteStale(): bool { return Records.items.compareDelete(new Key(), new Value()); }
