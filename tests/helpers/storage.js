function fakeStorage(initial = {}) {
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  return {
    values: clone(initial), writes: [], failWrite: '', failRead: false, dropWrite: '',
    getStorageInfoSync() { if (this.failRead) throw Error('read failed'); return { keys: Object.keys(this.values) }; },
    getStorageSync(key) { if (this.failRead) throw Error('read failed'); return clone(this.values[key]); },
    setStorageSync(key, value) {
      this.writes.push(key);
      if (this.failWrite === key) throw Error('quota exceeded');
      if (this.dropWrite !== key) this.values[key] = clone(value);
    },
  };
}
module.exports = { fakeStorage };
