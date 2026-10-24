const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'prototype', 'constructor'].includes(key);

export function isMarketState(value) {
  return record(value) && Array.isArray(value.events) && record(value.books);
}

// Each changed token carries a complete book. Keep untouched books by reference,
// and never mutate the previous snapshot while applying an ordered SSE patch.
export function mergeStatePatch(state, patch) {
  if (!isMarketState(state) || !record(patch) || !record(patch.set) || !record(patch.books) ||
      !Array.isArray(patch.removedBooks) || Object.hasOwn(patch.set, 'books') ||
      Object.keys(patch.set).some(key => !safeKey(key)) ||
      Object.entries(patch.books).some(([key, book]) => !safeKey(key) || !record(book)) ||
      patch.removedBooks.some(key => typeof key !== 'string' || !safeKey(key) || Object.hasOwn(patch.books, key))) return null;
  const changed = Object.keys(patch.books).length || patch.removedBooks.length;
  const books = changed ? { ...state.books, ...patch.books } : state.books;
  for (const token of patch.removedBooks) delete books[token];
  const next = { ...state, ...patch.set, books };
  return isMarketState(next) ? next : null;
}
