# Fullstack Starter

Project structure:

- `frontend` - React + Vite + TypeScript + TailwindCSS + shadcn/ui client
- `backend` - Node.js + Express API

## Setup

```bash
npm install:all
```

Create backend env file:

```bash
cp backend/.env.example backend/.env
```

Then set your Anthropic key in `backend/.env`:

```env
ANTHROPIC_KEY=your_real_key
```

## Run

Terminal 1:

```bash
npm run dev:backend
```

Terminal 2:

```bash
npm run dev:frontend
```

Frontend: http://localhost:5173
Backend health: http://localhost:4000/api/health

## LLM JSON Contract

`POST /api/agent` expects model output in strict JSON:

```json
{
  "type": "text|file",
  "format": "file format",
  "content": "simple text | file content"
}
```

- `type="text"`: `content` is plain answer text (or markdown), `format` usually `txt`/`md`.
- `type="file"`: `format` must be `csv`, `txt`, or `md`; backend saves `content` to file and returns download URL.

## Automation Runs (Step-by-step)

Use asynchronous automation endpoints to observe progress:

- `POST /api/automations/run` with `{ "instruction": "..." }` starts a run.
- `GET /api/automations/:id` returns current state, steps, status, and final result.

The frontend chat now uses this flow and shows live automation steps while the agent is running.

## Gmail MCP Connection (Upstream Data)

The agent can optionally read upstream user data via Gmail MCP during automation.

- Toggle in UI: `Enable Gmail MCP` / `Disable Gmail MCP`
- Backend endpoints:
  - `GET /api/connections/gmail`
  - `POST /api/connections/gmail` with `{ "enabled": true|false }`

When enabled, automation adds a step:

- `Read upstream data (Gmail MCP)`

and run state shows whether Gmail MCP was actually used, which MCP tool was called, and any connection error.

Default Gmail MCP server command is:

- `npx -y @gongrzhe/server-gmail-autoauth-mcp`

You can override with env vars:

- `GMAIL_MCP_COMMAND`
- `GMAIL_MCP_ARGS` (space-separated args)

## CSV News Task

In chat, send an instruction like:

`Fetch the latest AI news from the web and save them into a CSV`

The backend will generate a CSV file and the chat response will include a **Download CSV** button.

## Generic File Generation API

Create downloadable files in `csv`, `txt`, or `md`:

`POST /api/files/generate`

Example (`txt`):

```bash
curl -X POST http://localhost:4000/api/files/generate \
  -H "Content-Type: application/json" \
  -d '{"format":"txt","fileName":"notes","content":"Hello from API"}'
```

Example (`md`):

```bash
curl -X POST http://localhost:4000/api/files/generate \
  -H "Content-Type: application/json" \
  -d '{"format":"md","fileName":"summary","content":"# Summary\n\nGenerated file."}'
```

Example (`csv` from rows):

```bash
curl -X POST http://localhost:4000/api/files/generate \
  -H "Content-Type: application/json" \
  -d '{"format":"csv","fileName":"report","rows":[{"name":"Alice","score":10},{"name":"Bob","score":8}]}'
```
