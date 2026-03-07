#!/usr/bin/env node
import { agentikitSearch, agentikitOpen, agentikitRun, type KnowledgeView } from "./stash"
import { agentikitInit } from "./init"
import { agentikitIndex } from "./indexer"

const args = process.argv.slice(2)
const command = args[0]

type FlagKind = "boolean" | "string"

function parseCliArgs(
  argv: string[],
  specs: Record<string, FlagKind>,
): { flags: Record<string, string | boolean | undefined>; positionals: string[] } {
  const flags: Record<string, string | boolean | undefined> = {}
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const kind = specs[arg]

    if (kind === "boolean") {
      flags[arg] = true
      continue
    }

    if (kind === "string") {
      if (i + 1 < argv.length) {
        flags[arg] = argv[i + 1]
        i++
      }
      continue
    }

    if (arg.startsWith("--")) {
      continue
    }

    positionals.push(arg)
  }

  return { flags, positionals }
}

function usage(): never {
  console.error("Usage: agentikit <init|search|open|run> [options]")
  console.error("")
  console.error("Commands:")
  console.error("  init                 Initialize agentikit stash directory and set AGENTIKIT_STASH_DIR")
  console.error("  index [--full]       Build search index (incremental by default; --full forces full reindex)")
  console.error("  search [query]       Search the stash (--type tool|skill|command|agent|knowledge|any) (--limit N)")
  console.error("  open <type:name>     Open a stash asset by ref")
  console.error("       Knowledge view options: --view full|toc|frontmatter|section|lines")
  console.error("         --heading <text>   Section heading (for --view section)")
  console.error("         --start <N>        Start line (for --view lines)")
  console.error("         --end <N>          End line (for --view lines)")
  console.error("  run <type:name>      Run a tool by ref")
  process.exit(1)
}

try {
  switch (command) {
    case "init": {
      const result = agentikitInit()
      console.log(JSON.stringify(result, null, 2))
      break
    }
    case "index": {
      const parsed = parseCliArgs(args.slice(1), { "--full": "boolean" })
      const full = parsed.flags["--full"] === true
      const result = agentikitIndex({ full })
      console.log(JSON.stringify(result, null, 2))
      break
    }
    case "search": {
      const parsed = parseCliArgs(args.slice(1), { "--type": "string", "--limit": "string" })
      const query = parsed.positionals.join(" ")
      const type = parsed.flags["--type"] as "tool" | "skill" | "command" | "agent" | "any" | undefined
      const limitStr = parsed.flags["--limit"] as string | undefined
      const limit = limitStr ? parseInt(limitStr, 10) : undefined
      console.log(JSON.stringify(agentikitSearch({ query, type, limit }), null, 2))
      break
    }
    case "open": {
      const ref = args[1]
      if (!ref) { console.error("Error: missing ref argument\n"); usage() }
      const parsed = parseCliArgs(args.slice(2), {
        "--view": "string",
        "--heading": "string",
        "--start": "string",
        "--end": "string",
      })
      const viewMode = parsed.flags["--view"] as string | undefined
      let view: KnowledgeView | undefined
      if (viewMode) {
        switch (viewMode) {
          case "section":
            view = { mode: "section", heading: (parsed.flags["--heading"] as string | undefined) ?? "" }
            break
          case "lines": {
            const startVal = parsed.flags["--start"] as string | undefined
            const endVal = parsed.flags["--end"] as string | undefined
            view = {
              mode: "lines",
              start: Number(startVal ?? "1"),
              end: endVal ? parseInt(endVal, 10) : Number.MAX_SAFE_INTEGER,
            }
            break
          }
          case "toc":
          case "frontmatter":
          case "full":
            view = { mode: viewMode }
            break
          default:
            console.error(`Unknown view mode: ${viewMode}`)
            usage()
        }
      }
      console.log(JSON.stringify(agentikitOpen({ ref, view }), null, 2))
      break
    }
    case "run": {
      const ref = args[1]
      if (!ref) { console.error("Error: missing ref argument\n"); usage() }
      const result = agentikitRun({ ref })
      console.log(JSON.stringify(result, null, 2))
      process.exit(result.exitCode)
      break
    }
    default:
      usage()
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
