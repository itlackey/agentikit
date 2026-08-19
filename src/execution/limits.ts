// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Maximum portable timer delay: setTimeout's signed 32-bit ceiling (~24.8 days). */
export const EXECUTION_MAX_TIMEOUT_MS = 2 ** 31 - 1;
