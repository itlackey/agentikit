// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { copyDefaultModelMap } from "../integrations/agent/model-map";

/** Operator-owned model-map lifecycle commands. Alias expansion is consumed through the runtime API. */
export const modelsCommand = defineGroupCommand({
  meta: { name: "models", description: "Inspect and customize model intent alias defaults" },
  subCommands: {
    "copy-defaults": defineJsonCommand({
      meta: {
        name: "copy-defaults",
        description: "Copy AKM's installed models.json into the user configuration directory",
      },
      args: {
        overwrite: {
          type: "boolean",
          default: false,
          description: "Confirm replacing an existing regular user models.json file",
        },
      },
      run({ args }) {
        output("models", copyDefaultModelMap({ overwrite: args.overwrite === true }));
      },
    }),
  },
});
