# specguard-mcp

> The MCP bridge to [SpecGuard](https://github.com/yatfa-ai/specguard) — gives an AI agent the suite
> intelligence behind a very large test suite as tools.

> **Status: scaffolded.** This repository is bootstrapped; the server is not yet implemented or
> published. The surface below is the intended design, not a shipped contract.

`specguard-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects
an MCP-capable agent (Claude Code, Claude Desktop, …) to a SpecGuard deployment, so the agent can ask
what a suite covers, what it costs to run, how fast it is growing, and where the gaps are — the same
answers the SpecGuard dashboard renders, as tools an agent can call.

SpecGuard is built [primarily for AI coding agents](https://github.com/yatfa-ai/specguard); this
bridge is how an agent reaches it without scraping a web UI.

## Install

```bash
npx specguard-mcp
```

## Configure

| Variable | Required | Default | What it is |
| --- | --- | --- | --- |
| `SPECGUARD_API_KEY` | yes | — | an agent/CI API key (`sgk_…`) issued by your SpecGuard deployment |
| `SPECGUARD_ENDPOINT` | yes | — | your SpecGuard instance's root URL, e.g. `https://specguard.example.com` |

Register it with your MCP client — for Claude Code:

```json
{
  "mcpServers": {
    "specguard": {
      "command": "npx",
      "args": ["specguard-mcp"],
      "env": {
        "SPECGUARD_API_KEY": "sgk_…",
        "SPECGUARD_ENDPOINT": "https://specguard.example.com"
      }
    }
  }
}
```

`SPECGUARD_API_KEY` and `SPECGUARD_ENDPOINT` are the same variables
[`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec) uses to ship a run, so a repository
that already posts telemetry to SpecGuard already has them.

## How it works

The server speaks MCP over **stdio** and routes every call through your SpecGuard deployment:

```
agent  ⇄  specguard-mcp  ⇄  SpecGuard
        (stdio/MCP)        (HTTP, same API as the dashboard)
```

Authorization and project scoping are enforced by SpecGuard — never by this bridge — using the same
`sgk_…` keys CI uses to ingest runs. The bridge adds no credentials of its own and stores nothing.

## Related repositories

- [`specguard`](https://github.com/yatfa-ai/specguard) — the platform: ingest API + Hotwire dashboard
- [`specguard-rspec`](https://github.com/yatfa-ai/specguard-rspec) — Ruby client (RSpec formatter + `@intent` linter)
- [`open-test-intent`](https://github.com/yatfa-ai/open-test-intent) — the annotation protocol SpecGuard consumes

## License

ISC

---

<p align="center">
  <a href="https://yatfa.com">
    <img src="assets/built-with-yatfa.png" alt="Built with yatfa — a team of AI agents that plans, builds &amp; ships software." width="100%">
  </a>
</p>
