const task = require("./recognition-task");
const MAX_CONCURRENCY = 3;

function createQueue() {
  const waiting = [];
  let active = 0;
  function pump() {
    while (active < MAX_CONCURRENCY && waiting.length) {
      const entry = waiting.shift();
      if (entry.cancelled) continue;
      active++;
      entry.onStart();
      entry.job = task.start(entry.work, entry.timeoutMs, entry.onStage, entry.onSlow);
      entry.job.promise.then(entry.resolve, entry.reject);
      entry.job.settled.then(() => { active--; pump(); });
    }
  }
  function add(work, { timeoutMs, onStart = () => {}, onStage = () => {}, onSlow = () => {} } = {}) {
    const entry = { work, timeoutMs, onStart, onStage, onSlow };
    const promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
    waiting.push(entry);
    // Give the caller time to attach its cancellation handle before callbacks run.
    Promise.resolve().then(pump);
    return { promise, cancel(code = "CANCELLED") {
      if (entry.job) entry.job.cancel(code);
      else if (!entry.cancelled) { entry.cancelled = true; entry.reject(task.error(code)); }
    } };
  }
  return { add };
}
module.exports = { createQueue, MAX_CONCURRENCY };
