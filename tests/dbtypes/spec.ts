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
