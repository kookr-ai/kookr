import { readFileSync, writeSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { TaskSqliteStore, hydrateTaskFromPersistedJson } from '../../src/core/task-sqlite-store.js';

const [dbPath, inputPath, phase] = process.argv.slice(2);
assert(dbPath && inputPath);
assert(phase === 'mid-flush' || phase === 'after-commit');
const input = JSON.parse(readFileSync(inputPath, 'utf8')) as { before: unknown[]; after: unknown[] };
const store = new TaskSqliteStore(dbPath);
store.flush({ tasks: input.before.map(hydrateTaskFromPersistedJson), deletedTaskIds: [] });

// Access the real connection only to install a connection-local crash barrier;
// no runtime hook or replacement of the store's statements is needed.
const db = store['db'];
function pauseForKill(): never {
  assert.equal(db.inTransaction, phase === 'mid-flush');
  // Synchronous delivery works even while SQLite's callback blocks the event loop.
  writeSync(1, `READY ${phase}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20_000);
  throw new Error('Parent did not kill the writer within twenty seconds');
}

if (phase === 'mid-flush') {
  db.function('pause_for_kill', pauseForKill);
  // The old mapping has been deleted and only the first new session inserted.
  // This trigger belongs to this connection and disappears when the child dies.
  db.exec(`
    CREATE TEMP TRIGGER crash_during_session_replacement
    AFTER INSERT ON task_sessions
    BEGIN
      SELECT pause_for_kill();
    END;
  `);
}

store.flush({ tasks: input.after.map(hydrateTaskFromPersistedJson), deletedTaskIds: [] });
assert.equal(phase, 'after-commit', 'The mid-flush barrier was not reached');
pauseForKill();
