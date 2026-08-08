# Recipe: Turn a Website into a Searchable Bundle

Crawl a documentation site into markdown knowledge assets you can search and
show like any other source.

```sh
akm bundle add https://docs.example.com --name docs
```

Website sources are crawled and converted to markdown knowledge assets, then
indexed locally — no different from a local directory or a git bundle once
they're in.

Control the crawl scope with `--max-pages` and `--max-depth`:

```sh
akm bundle add https://www.agentic-patterns.com/ --name agent-patterns --max-pages 100
```

Reindex and search once the crawl finishes:

```sh
akm index
akm search "agent" --type knowledge
```

See [Registry](../../reference/registry.md) for the full install flow and
supported ref formats.
