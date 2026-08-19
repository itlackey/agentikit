// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { appendEvent } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";

const [, , readyPath, goPath, committedPath, releasePath, observedPath, marker] = process.argv;
if (!readyPath || !goPath || !committedPath || !releasePath || !observedPath || !marker) {
  throw new Error("usage: update-state-event-worker <ready> <go> <committed> <release> <observed> <marker>");
}

function waitFor(filePath: string): void {
  while (!fs.existsSync(filePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

const db = openStateDatabase();
try {
  fs.writeFileSync(readyPath, "ready");
  waitFor(goPath);
  appendEvent({ eventType: "update", ref: marker }, { db });
  const row = db.prepare("SELECT COUNT(*) AS count FROM events WHERE ref = ?").get(marker) as { count: number };
  if (row.count !== 1) throw new Error(`event ${marker} did not commit`);
  fs.writeFileSync(committedPath, "committed");
  waitFor(releasePath);
  const observed = db.prepare("SELECT COUNT(*) AS count FROM events WHERE ref = ?").get(marker) as { count: number };
  fs.writeFileSync(observedPath, String(observed.count));
} finally {
  db.close();
}
