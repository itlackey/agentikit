import { resolveStashDir } from "./common"
import { parseOpenRef } from "./stash-ref"
import { resolveAssetPath } from "./stash-resolve"
import type { RunResponse } from "./stash-types"
import { buildToolInfo, runToolExecution } from "./tool-runner"

export function agentikitRun(input: { ref: string }): RunResponse {
  const parsed = parseOpenRef(input.ref)
  if (parsed.type === "knowledge") {
    throw new Error(
      `Knowledge assets are read-only. Use agentikitOpen with ref "${input.ref}" instead.`
      + ` You can pass a view parameter to retrieve specific sections, line ranges, or the table of contents.`,
    )
  }
  if (parsed.type !== "tool") {
    throw new Error(`agentikitRun only supports tool refs. Got: "${parsed.type}".`)
  }
  const stashDir = resolveStashDir()
  const assetPath = resolveAssetPath(stashDir, "tool", parsed.name)
  const toolInfo = buildToolInfo(stashDir, assetPath)

  if (toolInfo.install) {
    const installResult = runToolExecution(toolInfo.install)
    if (installResult.exitCode !== 0) {
      return {
        type: "tool",
        name: parsed.name,
        path: assetPath,
        output: installResult.output,
        exitCode: installResult.exitCode,
      }
    }
  }

  const runResult = runToolExecution(toolInfo.execute)

  return {
    type: "tool",
    name: parsed.name,
    path: assetPath,
    output: runResult.output,
    exitCode: runResult.exitCode,
  }
}
