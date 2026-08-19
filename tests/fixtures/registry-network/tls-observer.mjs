// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import https from "node:https";
import tls from "node:tls";

const [certPath, keyPath] = process.argv.slice(2);
if (!certPath || !keyPath) throw new Error("Expected certificate and key paths");

const cert = fs.readFileSync(certPath);
const key = fs.readFileSync(keyPath);
const secureContext = tls.createSecureContext({ cert, key });
let observedServername;
const server = https.createServer(
  {
    cert,
    key,
    SNICallback(servername, callback) {
      observedServername = servername;
      callback(null, secureContext);
    },
  },
  (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        host: request.headers.host,
        remoteAddress: request.socket.remoteAddress,
        servername: observedServername ?? request.socket.servername,
      }),
    );
  },
);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TLS observer did not expose a TCP port");
  process.stdout.write(`${address.port}\n`);
});

process.stdin.once("data", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
