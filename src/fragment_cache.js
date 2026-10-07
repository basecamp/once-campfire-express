// Byte-bounded LRU of rendered HTML. Keys carry every input that changes the output, so entries
// are never invalidated, only aged out. Cost counts UTF-16 code units at two bytes each.
export class FragmentCache {
  #entries = new Map();
  #max;
  size = 0;
  constructor(maxBytes) {
    this.#max = maxBytes;
  }
  has(key) {
    return this.#entries.has(key);
  }
  fetch(key, build) {
    const hit = this.#entries.get(key);
    if (hit !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, hit);
      return hit;
    }
    const value = build();
    const cost = (key.length + value.length) * 2;
    if (cost > this.#max / 2) return value;
    this.#entries.set(key, value);
    this.size += cost;
    while (this.size > this.#max) {
      const [oldKey, oldValue] = this.#entries.entries().next().value;
      this.#entries.delete(oldKey);
      this.size -= (oldKey.length + oldValue.length) * 2;
    }
    return value;
  }
  clear() {
    this.#entries.clear();
    this.size = 0;
  }
}
