/* Aufnahmen im Browser speichern (IndexedDB). Metadaten und Messdaten liegen getrennt,
 * damit die Liste schnell lädt. Fällt IndexedDB aus, wird nur im Arbeitsspeicher gehalten. */
(function (global) {
  'use strict';

  const DB_NAME = 'polar-ekg';
  const DB_VERSION = 1;

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  class IdbStore {
    async open() {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('data', { keyPath: 'id' });
      };
      this.db = await req(r);
    }

    async save(meta, data) {
      const tx = this.db.transaction(['meta', 'data'], 'readwrite');
      const add = tx.objectStore('meta').add(meta);
      add.onsuccess = () => tx.objectStore('data').put({ id: add.result, ...data });
      await txDone(tx);
      return add.result;
    }

    async updateMeta(meta) {
      const tx = this.db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(meta);
      await txDone(tx);
    }

    async list() {
      const all = await req(this.db.transaction('meta').objectStore('meta').getAll());
      return all.sort((a, b) => b.startTime - a.startTime);
    }

    async get(id) {
      const tx = this.db.transaction(['meta', 'data']);
      const [meta, data] = await Promise.all([
        req(tx.objectStore('meta').get(id)),
        req(tx.objectStore('data').get(id))
      ]);
      return meta && data ? { meta, data } : null;
    }

    async remove(id) {
      const tx = this.db.transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('meta').delete(id);
      tx.objectStore('data').delete(id);
      await txDone(tx);
    }
  }

  class MemoryStore {
    constructor() { this.items = new Map(); this.nextId = 1; }
    async open() {}
    async save(meta, data) {
      const id = this.nextId++;
      this.items.set(id, { meta: { ...meta, id }, data: { id, ...data } });
      return id;
    }
    async updateMeta(meta) { const it = this.items.get(meta.id); if (it) it.meta = meta; }
    async list() { return [...this.items.values()].map(i => i.meta).sort((a, b) => b.startTime - a.startTime); }
    async get(id) { return this.items.get(id) || null; }
    async remove(id) { this.items.delete(id); }
  }

  async function openStorage() {
    try {
      const s = new IdbStore();
      await s.open();
      return { store: s, persistent: true };
    } catch (err) {
      console.warn('IndexedDB nicht verfügbar, nutze Arbeitsspeicher', err);
      return { store: new MemoryStore(), persistent: false };
    }
  }

  global.EkgStorage = { openStorage };
})(window);
