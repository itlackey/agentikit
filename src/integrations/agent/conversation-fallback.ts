// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ResolvedConversationMessage } from "../../execution/resolved-request";

export const CONVERSATION_FALLBACK_BEGIN = "<AKM_CONVERSATION_JSON>";
export const CONVERSATION_FALLBACK_END = "</AKM_CONVERSATION_JSON>";

/**
 * Preserve ordered message roles for a one-shot transport with no native
 * conversation channel. The fixed `{role,content}` projection and UTF-8 byte
 * length make the embedded JSON unambiguous even when content contains marker
 * text. The terminal command remains outside the prefix block.
 */
export function composeConversationFallbackPrompt(
  conversation: readonly Readonly<ResolvedConversationMessage>[],
  command: string,
): string {
  const json = JSON.stringify(conversation.map((message) => ({ role: message.role, content: message.content })));
  const byteLength = new TextEncoder().encode(json).byteLength;
  return `${CONVERSATION_FALLBACK_BEGIN} ${byteLength}\n${json}\n${CONVERSATION_FALLBACK_END}\n\n${command}`;
}
