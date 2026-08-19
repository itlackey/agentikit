// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

require("node:https").request({});
(0, require("node:https").request)({});
(await import("node:https")).request({});
process.getBuiltinModule("node:net").connect({});
Bun.connect({ hostname: "example.test", port: 443, socket: {} });
Bun.udpSocket({ socket: {} });
