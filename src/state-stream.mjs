// Cache the JSON representation, not object references: monitor books are updated in place.
function capture(state, previous) {
  const fields = new Map();
  const books = new Map();
  const changedFields = new Map();
  const changedBooks = new Map();
  for (const [key, value] of Object.entries(state)) {
    if (key === 'books') continue;
    const json = JSON.stringify(value);
    if (json === undefined) continue;
    fields.set(key, json);
    if (previous?.fields.get(key) !== json) changedFields.set(key, json);
  }
  // Top-level state fields normally have a fixed schema. Clear an omitted optional field.
  for (const key of previous?.fields.keys() ?? []) {
    if (!fields.has(key)) changedFields.set(key, 'null');
  }
  for (const [token, book] of Object.entries(state.books ?? {})) {
    const json = JSON.stringify(book);
    if (json === undefined) continue;
    books.set(token, json);
    if (previous?.books.get(token) !== json) changedBooks.set(token, json);
  }
  const removedBooks = [...(previous?.books.keys() ?? [])].filter(token => !books.has(token));
  return { fields, books, changedFields, changedBooks, removedBooks, full: null };
}

const jsonObject = entries => `{${[...entries].map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',')}}`;
const message = (event, json) => {
  const text = `event: ${event}\ndata: ${json}\n\n`;
  return { text, bytes: Buffer.byteLength(text) };
};
const fullMessage = frame => frame.full ??= message('state', jsonObject([...frame.fields, ['books', jsonObject(frame.books)]]));
const patchMessage = frame => message('patch', `{"set":${jsonObject(frame.changedFields)},"books":${jsonObject(frame.changedBooks)},"removedBooks":${JSON.stringify(frame.removedBooks)}}`);

/** Full baseline on connect; optional book deltas thereafter. All clients share one encoding. */
export class StateStream {
  constructor({ maxBufferedBytes = 2 * 1024 * 1024 } = {}) {
    this.clients = new Map();
    this.previous = null;
    this.maxBufferedBytes = maxBufferedBytes;
  }

  add(response, state, { delta = false } = {}) {
    // Flush pending changes to existing clients before a new client gets this baseline.
    // Otherwise an update between broadcasts could disappear from the old clients' diffs.
    const frame = this.clients.size ? this.publish(state) : capture(state);
    this.previous = frame;
    this.clients.set(response, delta);
    this.send(response, fullMessage(frame));
  }

  remove(response) {
    this.clients.delete(response);
    if (!this.clients.size) this.previous = null;
  }

  send(response, payload) {
    const pending = response.writableLength ?? 0;
    if (response.destroyed || response.writableEnded || (pending > 0 && pending + payload.bytes > this.maxBufferedBytes)) {
      this.remove(response);
      if (!response.destroyed) response.destroy();
      return;
    }
    try { response.write(payload.text); }
    catch { this.remove(response); response.destroy(); }
  }

  publish(state) {
    if (!this.clients.size) return;
    const frame = capture(state, this.previous);
    this.previous = frame;
    if (!frame.changedFields.size && !frame.changedBooks.size && !frame.removedBooks.length) return frame;
    let patch;
    for (const [response, delta] of this.clients) {
      this.send(response, delta ? (patch ??= patchMessage(frame)) : fullMessage(frame));
    }
    return frame;
  }

  heartbeat() {
    const payload = { text: ': heartbeat\n\n', bytes: 13 };
    for (const response of this.clients.keys()) this.send(response, payload);
  }

  close() {
    for (const response of this.clients.keys()) response.end();
    this.clients.clear();
    this.previous = null;
  }
}
