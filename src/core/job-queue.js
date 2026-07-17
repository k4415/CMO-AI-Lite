export class KeyedFifoQueue {
  constructor() {
    this.states = new Map();
  }

  run(key, task) {
    const normalizedKey = String(key || "default");
    let state = this.states.get(normalizedKey);
    if (!state) {
      state = { running: false, items: [] };
      this.states.set(normalizedKey, state);
    }
    return new Promise((resolve, reject) => {
      state.items.push({ task, resolve, reject });
      this.#drain(normalizedKey, state);
    });
  }

  async #drain(key, state) {
    if (state.running) return;
    const item = state.items.shift();
    if (!item) {
      this.states.delete(key);
      return;
    }
    state.running = true;
    try {
      item.resolve(await item.task());
    } catch (error) {
      item.reject(error);
    } finally {
      state.running = false;
      this.#drain(key, state);
    }
  }
}

export class FifoWorkerPool {
  constructor(concurrency = 1) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.active = 0;
    this.items = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.items.push({ task, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.items.length) {
      const item = this.items.shift();
      this.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.#drain();
        });
    }
  }
}
