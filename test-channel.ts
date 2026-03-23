#!/usr/bin/env bun
/**
 * Integration test for the Stumpy channel MCP plugin.
 *
 * Starts a local mock WebSocket server, launches the MCP server as a child
 * process, performs the MCP handshake, calls join_team, then verifies that
 * an inbound WebSocket message produces an MCP channel notification on stdout.
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'

// --- Config ---
const OVERALL_TIMEOUT_MS = 15_000
const TEST_TOKEN = 'test-token-abc123'
const TEST_TEAM = 'test-team'
const TEST_CLIENT_NAME = 'test-client'
const TEST_FROM = 'TestAgent'
const TEST_CONTENT = 'hello from test'

// --- Helpers ---
let exitCode = 1
let child: ChildProcess | null = null
let mockServer: ReturnType<typeof Bun.serve> | null = null
let overallTimeout: ReturnType<typeof setTimeout> | null = null

function cleanup() {
  if (overallTimeout) clearTimeout(overallTimeout)
  if (child && !child.killed) {
    child.kill('SIGTERM')
  }
  if (mockServer) {
    mockServer.stop(true)
    mockServer = null
  }
}

function fail(reason: string): never {
  console.error(`\nFAIL: ${reason}`)
  cleanup()
  process.exit(1)
}

function pass() {
  console.log('\nPASS: inbound message notification received correctly')
  exitCode = 0
  cleanup()
  process.exit(0)
}

// Overall timeout
overallTimeout = setTimeout(() => {
  fail('overall timeout exceeded (15s)')
}, OVERALL_TIMEOUT_MS)

// --- Mock WebSocket server ---
// Track the connected WebSocket so we can push messages to the client.
let clientWs: any = null
let authReceived = false

// Use port 0 to let the OS pick a free port. Bun.serve doesn't support port 0
// directly, so we pick a random high port.
const mockPort = 10000 + Math.floor(Math.random() * 50000)

console.log(`Starting mock WebSocket server on port ${mockPort}...`)

mockServer = Bun.serve({
  port: mockPort,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/channel/connect') {
      const upgraded = server.upgrade(req)
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 })
      }
      return undefined
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      console.log('[mock] client connected')
      clientWs = ws
    },
    message(ws, message) {
      const data = JSON.parse(String(message))
      console.log(`[mock] received: ${JSON.stringify(data)}`)

      if (data.type === 'auth') {
        // Validate token
        if (data.token !== TEST_TOKEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'invalid token' }))
          return
        }
        authReceived = true
        ws.send(JSON.stringify({
          type: 'auth_ok',
          sessionId: 'mock-session-001',
          team: data.team,
          name: data.name,
        }))
        console.log('[mock] sent auth_ok')

        // After a brief delay, send the test inbound message
        setTimeout(() => {
          console.log('[mock] sending test message...')
          ws.send(JSON.stringify({
            type: 'message',
            from: TEST_FROM,
            content: TEST_CONTENT,
          }))
          console.log('[mock] test message sent')
        }, 500)
        return
      }
    },
    close(ws) {
      console.log('[mock] client disconnected')
      clientWs = null
    },
  },
})

console.log(`Mock server listening on ws://localhost:${mockPort}/channel/connect`)

// --- Start MCP server as child process ---
console.log('Starting MCP server child process...')

const bunPath = `${process.env.HOME}/.bun/bin/bun`

child = spawn(bunPath, ['run', 'server.ts'], {
  cwd: '/Users/pguillory/code/stumpy-channel',
  env: {
    ...process.env,
    STUMPY_TOKEN: TEST_TOKEN,
    STUMPY_WS_URL: `ws://localhost:${mockPort}/channel/connect`,
    // Prevent it from trying to read the .env file
    STUMPY_STATE_DIR: '/tmp/stumpy-channel-test-nonexistent',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

if (!child.stdin || !child.stdout || !child.stderr) {
  fail('Failed to get child process stdio')
}

// Collect stderr for debugging
child.stderr.on('data', (data: Buffer) => {
  const text = data.toString().trim()
  if (text) console.log(`[mcp stderr] ${text}`)
})

child.on('error', (err) => {
  fail(`child process error: ${err.message}`)
})

child.on('exit', (code, signal) => {
  console.log(`[mcp] process exited (code=${code}, signal=${signal})`)
})

// Read stdout line by line for JSON-RPC messages
const rl: Interface = createInterface({ input: child.stdout })
const receivedMessages: any[] = []

// State machine
let jsonRpcId = 0
let state: 'init' | 'wait_init_response' | 'wait_join_response' | 'wait_notification' = 'init'

function sendJsonRpc(obj: Record<string, unknown>) {
  const line = JSON.stringify(obj)
  console.log(`[test -> mcp] ${line}`)
  child!.stdin!.write(line + '\n')
}

rl.on('line', (line: string) => {
  console.log(`[mcp stdout] ${line}`)

  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    // Not JSON, skip
    return
  }
  receivedMessages.push(msg)

  switch (state) {
    case 'wait_init_response': {
      if (msg.id === 1 && msg.result) {
        console.log('[test] initialize response received')
        console.log(`[test] server capabilities: ${JSON.stringify(msg.result.capabilities)}`)

        // Send initialized notification
        sendJsonRpc({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        })
        console.log('[test] sent initialized notification')

        // Now call join_team
        state = 'wait_join_response'
        jsonRpcId = 2
        sendJsonRpc({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'join_team',
            arguments: {
              team: TEST_TEAM,
              name: TEST_CLIENT_NAME,
            },
          },
        })
        console.log('[test] sent join_team tool call')
      }
      break
    }

    case 'wait_join_response': {
      if (msg.id === 2 && msg.result) {
        console.log(`[test] join_team response: ${JSON.stringify(msg.result)}`)
        if (msg.result.isError) {
          fail(`join_team returned error: ${JSON.stringify(msg.result.content)}`)
        }
        console.log('[test] joined team, waiting for inbound message notification...')
        state = 'wait_notification'
      }
      break
    }

    case 'wait_notification': {
      if (msg.method === 'notifications/claude/channel') {
        console.log(`[test] received channel notification: ${JSON.stringify(msg)}`)

        // Validate the notification
        const params = msg.params
        if (!params) {
          fail('notification missing params')
        }
        if (params.content !== TEST_CONTENT) {
          fail(`content mismatch: expected "${TEST_CONTENT}", got "${params.content}"`)
        }
        if (!params.meta) {
          fail('notification missing meta')
        }
        if (params.meta.from !== TEST_FROM) {
          fail(`from mismatch: expected "${TEST_FROM}", got "${params.meta.from}"`)
        }
        if (params.meta.team !== TEST_TEAM) {
          fail(`team mismatch: expected "${TEST_TEAM}", got "${params.meta.team}"`)
        }

        pass()
        return
      }
      break
    }
  }
})

// Start the handshake after a brief delay to let the process start
setTimeout(() => {
  console.log('[test] starting MCP handshake...')
  state = 'wait_init_response'
  jsonRpcId = 1
  sendJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'test-harness',
        version: '1.0.0',
      },
    },
  })
}, 500)
