class LockManager {
  constructor() {
    this.queueByKey = new Map();
  }

  async runWithLock(key, fn) {
    const prev = this.queueByKey.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });

    this.queueByKey.set(key, prev.then(() => current));
    await prev;

    try {
      return await fn();
    } finally {
      release();
      if (this.queueByKey.get(key) === current) {
        this.queueByKey.delete(key);
      }
    }
  }
}

module.exports = {
  LockManager
};
