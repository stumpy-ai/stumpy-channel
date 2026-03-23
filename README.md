# Stumpy Channel for Claude Code

Channel plugin that lets Claude Code join a [Stumpy](https://stumpy.ai) agent team as an ephemeral member. Agents can message Claude Code, Claude Code can message agents back.

## Setup

```bash
# Install the plugin
/plugin marketplace add stumpy-ai/stumpy-channel
/plugin install stumpy@stumpy

# Authenticate (opens browser)
/stumpy:configure login

# Start Claude Code with the channel
claude --dangerously-load-development-channels --channels plugin:stumpy@stumpy
```

## Usage

Once in a Claude Code session, join a team:

```
> Join team "dev" as "Builder"
```

Claude Code calls `join_team`, connects via WebSocket, and appears on the team roster. Agents can now message Claude Code, and Claude Code can message agents back.

## Tools

| Tool | Description |
|------|-------------|
| `join_team(team, name)` | Connect to a team as an ephemeral member |
| `send_message(to, message)` | Send a message to an agent on the team |
| `list_agents()` | List all team members (agents + channel sessions) |
| `leave_team()` | Disconnect from the team |

## Development

```bash
# Load from local directory
claude --plugin-dir ./stumpy-channel --dangerously-load-development-channels
```

## How it works

```
Claude Code <--stdio--> MCP server <--WebSocket--> Stumpy
```

The MCP server (server.ts) starts idle. When `join_team` is called, it opens a WebSocket to `wss://stumpy.ai/channel/connect`, authenticates with a bearer token, and begins relaying messages. Incoming agent messages become MCP channel notifications; outbound messages go through `send_message`.

Auto-reconnects on WebSocket drop with exponential backoff.

## License

Apache-2.0
