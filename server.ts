#!/usr/bin/env bun
/**
 * Stumpy channel for Claude Code.
 *
 * MCP server that bridges Claude Code into a Stumpy agent team as an ephemeral
 * member. Starts idle — WebSocket connects only when join_team is called.
 * Incoming agent messages become MCP channel notifications; outbound messages
 * go through send_message.
 *
 * Token lives in ~/.claude/channels/stumpy/.env — obtained via browser OAuth
 * through the /stumpy:configure skill.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = process.env.STUMPY_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'stumpy')
const ENV_FILE = join(STATE_DIR, '.env')

// Load ~/.claude/channels/stumpy/.env into process.env. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.STUMPY_TOKEN
const WS_URL = process.env.STUMPY_WS_URL ?? 'wss://stumpy.ai/channel/connect'

// Last-resort safety net — keep serving tools on unhandled errors.
process.on('unhandledRejection', err => {
  process.stderr.write(`stumpy channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`stumpy channel: uncaught exception: ${err}\n`)
})

// --- WebSocket state ---

let ws: WebSocket | null = null
let currentTeam: string | null = null
let currentName: string | null = null
let sessionId: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let intentionalClose = false

// Pending request/response tracking. The WebSocket protocol sends responses
// inline — we match them by type since only one request is in flight at a time.
type PendingResolve = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}
let pendingAuth: PendingResolve | null = null
let pendingListAgents: PendingResolve | null = null
let pendingSendMessage: PendingResolve | null = null

function clearPending(p: PendingResolve | null, err?: Error): null {
  if (p) {
    clearTimeout(p.timeout)
    if (err) p.reject(err)
  }
  return null
}

function clearAllPending(err: Error): void {
  pendingAuth = clearPending(pendingAuth, err)
  pendingListAgents = clearPending(pendingListAgents, err)
  pendingSendMessage = clearPending(pendingSendMessage, err)
}

function sendWs(data: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('not connected — call join_team first')
  }
  ws.send(JSON.stringify(data))
}

function makePending(timeoutMs: number): { pending: PendingResolve; promise: Promise<unknown> } {
  let pending!: PendingResolve
  const promise = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('request timed out')), timeoutMs)
    pending = { resolve, reject, timeout }
  })
  return { pending, promise }
}

function connectWebSocket(team: string, name: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    intentionalClose = false
    reconnectAttempt = 0
    let settled = false

    const settle = (fn: typeof resolve | typeof reject, value: unknown) => {
      if (settled) return
      settled = true
      fn(value as string)
    }

    const socket = new WebSocket(WS_URL)

    socket.onopen = () => {
      process.stderr.write(`stumpy channel: WebSocket connected, authenticating...\n`)
      // Send auth message
      socket.send(JSON.stringify({ type: 'auth', token, team, name }))

      // Set up auth pending
      const timeout = setTimeout(() => {
        settle(reject, new Error('auth timed out'))
        socket.close()
      }, 15000)

      pendingAuth = {
        resolve: (value) => {
          const result = value as { sessionId: string }
          sessionId = result.sessionId
          ws = socket
          currentTeam = team
          currentName = name
          process.stderr.write(`stumpy channel: joined team "${team}" as "${name}" (session: ${sessionId})\n`)
          settle(resolve, sessionId)
        },
        reject: (err) => {
          settle(reject, err)
          socket.close()
        },
        timeout,
      }
    }

    socket.onmessage = (event) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        process.stderr.write(`stumpy channel: unparseable message: ${event.data}\n`)
        return
      }

      process.stderr.write(`stumpy channel: ws recv: ${msg.type}\n`)
      switch (msg.type) {
        case 'auth_ok': {
          if (pendingAuth) {
            clearTimeout(pendingAuth.timeout)
            pendingAuth.resolve(msg)
            pendingAuth = null
          }
          break
        }

        case 'error': {
          const errMsg = String(msg.message ?? 'unknown error')
          // Route error to the appropriate pending request
          if (pendingAuth) {
            clearTimeout(pendingAuth.timeout)
            pendingAuth.reject(new Error(errMsg))
            pendingAuth = null
          } else if (pendingSendMessage) {
            clearTimeout(pendingSendMessage.timeout)
            pendingSendMessage.reject(new Error(errMsg))
            pendingSendMessage = null
          } else if (pendingListAgents) {
            clearTimeout(pendingListAgents.timeout)
            pendingListAgents.reject(new Error(errMsg))
            pendingListAgents = null
          } else {
            process.stderr.write(`stumpy channel: server error: ${errMsg}\n`)
          }
          break
        }

        case 'message_sent': {
          if (pendingSendMessage) {
            clearTimeout(pendingSendMessage.timeout)
            pendingSendMessage.resolve(msg)
            pendingSendMessage = null
          }
          break
        }

        case 'agents': {
          if (pendingListAgents) {
            clearTimeout(pendingListAgents.timeout)
            pendingListAgents.resolve(msg)
            pendingListAgents = null
          }
          break
        }

        case 'message': {
          // Incoming message from an agent — emit MCP notification
          process.stderr.write(`stumpy channel: incoming message from ${msg.from}: ${String(msg.content).slice(0, 100)}\n`)
          mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: String(msg.content ?? ''),
              meta: {
                from: String(msg.from ?? 'unknown'),
                team: currentTeam ?? '',
              },
            },
          }).catch(err => {
            process.stderr.write(`stumpy channel: failed to deliver inbound to Claude: ${err}\n`)
          })
          break
        }

        default:
          process.stderr.write(`stumpy channel: unknown message type: ${msg.type}\n`)
      }
    }

    socket.onclose = (event) => {
      const wasConnected = ws === socket
      ws = null
      sessionId = null

      // If we never completed auth, reject the connect promise
      settle(reject, new Error('WebSocket closed before auth completed'))
      clearAllPending(new Error('WebSocket closed'))

      if (intentionalClose) {
        process.stderr.write(`stumpy channel: disconnected\n`)
        return
      }

      if (wasConnected && currentTeam && currentName) {
        // Auto-reconnect
        scheduleReconnect()
      }
    }

    socket.onerror = () => {
      process.stderr.write(`stumpy channel: WebSocket error\n`)
      // onclose always fires after onerror, so rejection happens there
    }
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer || intentionalClose) return
  if (!TOKEN || !currentTeam || !currentName) return

  reconnectAttempt++
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000)
  process.stderr.write(`stumpy channel: reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})\n`)

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    if (intentionalClose || !currentTeam || !currentName || !TOKEN) return

    try {
      await connectWebSocket(currentTeam, currentName, TOKEN)
      reconnectAttempt = 0
    } catch (err) {
      process.stderr.write(`stumpy channel: reconnect failed: ${err}\n`)
      scheduleReconnect()
    }
  }, delay)
}

function disconnect(): void {
  intentionalClose = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  clearAllPending(new Error('disconnected'))
  if (ws) {
    ws.close()
    ws = null
  }
  sessionId = null
  currentTeam = null
  currentName = null
}

// --- MCP server ---

const mcp = new Server(
  { name: 'stumpy', version: '0.0.1' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'Messages from Stumpy agents arrive as <channel source="stumpy" from="AgentName" team="TeamName">. Reply using the send_message tool.',
      '',
      'Use join_team to connect to a Stumpy agent team. Use list_agents to see who is on the team. Use send_message to message specific agents. Use leave_team to disconnect.',
      '',
      'Stumpy agents are persistent AI agents that run 24/7 on the Stumpy platform (stumpy.ai). They can reach humans via Telegram, SMS, email, and phone. This channel lets you collaborate with them as an ephemeral team member.',
      '',
      'If no token is configured, tell the user to run /stumpy:configure to authenticate.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'join_team',
      description:
        'Join a Stumpy agent team. Opens a WebSocket connection and registers as an ephemeral channel member. Other agents on the team can then message you.',
      inputSchema: {
        type: 'object',
        properties: {
          team: {
            type: 'string',
            description: 'Team name to join.',
          },
          name: {
            type: 'string',
            description: 'Display name for this session (e.g. "claude-code").',
          },
        },
        required: ['team', 'name'],
      },
    },
    {
      name: 'send_message',
      description:
        'Send a message to an agent on the current team. Must be joined to a team first.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Agent name to send to.',
          },
          message: {
            type: 'string',
            description: 'Message text.',
          },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'list_agents',
      description:
        'List all members (agents and channel sessions) on the current team. Must be joined to a team first.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'leave_team',
      description: 'Disconnect from the current team.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'join_team': {
        const team = args.team as string
        const name = args.name as string

        if (!TOKEN) {
          throw new Error(
            'no token configured — run /stumpy:configure to authenticate with Stumpy',
          )
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
          // Already connected — disconnect first
          disconnect()
        }

        const sid = await connectWebSocket(team, name, TOKEN)
        return {
          content: [{ type: 'text', text: `joined team "${team}" as "${name}" (session: ${sid})` }],
        }
      }

      case 'send_message': {
        const to = args.to as string
        const message = args.message as string

        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error('not connected — call join_team first')
        }

        const { pending, promise } = makePending(15000)
        pendingSendMessage = pending
        sendWs({ type: 'send_message', to, message })
        const result = await promise as Record<string, unknown>
        return {
          content: [{ type: 'text', text: `message sent to ${result.to ?? to}` }],
        }
      }

      case 'list_agents': {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error('not connected — call join_team first')
        }

        const { pending, promise } = makePending(15000)
        pendingListAgents = pending
        sendWs({ type: 'list_agents' })
        const result = await promise as { agents: Array<{ name: string; type: string }> }
        const agents = result.agents ?? []

        if (agents.length === 0) {
          return { content: [{ type: 'text', text: `team "${currentTeam}": no members` }] }
        }

        const lines = agents.map(a => `  ${a.name} (${a.type})`).join('\n')
        return {
          content: [{ type: 'text', text: `team "${currentTeam}" members:\n${lines}` }],
        }
      }

      case 'leave_team': {
        if (!ws) {
          return { content: [{ type: 'text', text: 'not connected' }] }
        }
        const team = currentTeam
        disconnect()
        return { content: [{ type: 'text', text: `left team "${team}"` }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

await mcp.connect(new StdioServerTransport())

// When Claude Code closes the MCP connection, stdin gets EOF. Clean up
// the WebSocket so we don't leave a zombie session on Stumpy.
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('stumpy channel: shutting down\n')
  disconnect()
  setTimeout(() => process.exit(0), 1000)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
