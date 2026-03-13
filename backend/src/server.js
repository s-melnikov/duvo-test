import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { XMLParser } from 'fast-xml-parser';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.resolve(__dirname, '../generated');

const app = express();
const port = Number(process.env.PORT || 4000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const anthropicApiKey = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const anthropicMaxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || 512);

const anthropic = anthropicApiKey ? new Anthropic({ apiKey: anthropicApiKey }) : null;
const rssParser = new XMLParser({ ignoreAttributes: false });
const supportedFileFormats = new Set(['csv', 'txt', 'md']);
const agentResponseToolName = 'agent_response';
const webSearchToolName = 'web_search_ai_news';
const fetchUrlToolName = 'fetch_url_text';
const maxStoredRuns = 100;
const automationRuns = new Map();
const gmailMcpCommand = process.env.GMAIL_MCP_COMMAND || 'npx';
const gmailMcpArgs = process.env.GMAIL_MCP_ARGS
  ? process.env.GMAIL_MCP_ARGS.split(' ').map((part) => part.trim()).filter(Boolean)
  : ['-y', '@gongrzhe/server-gmail-autoauth-mcp'];
const connectionSettings = {
  gmail: {
    enabled: false,
    command: gmailMcpCommand,
    args: gmailMcpArgs,
    updatedAt: new Date().toISOString()
  }
};

app.use(cors({ origin: frontendOrigin }));
app.use(express.json());
app.use('/files', express.static(generatedDir));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    message: 'Backend is running',
    timestamp: new Date().toISOString()
  });
});

function nowIso() {
  return new Date().toISOString();
}

function getConnectionState() {
  return {
    gmail: {
      enabled: connectionSettings.gmail.enabled,
      command: connectionSettings.gmail.command,
      args: connectionSettings.gmail.args,
      updatedAt: connectionSettings.gmail.updatedAt
    }
  };
}

function escapeCsvCell(value) {
  const stringValue = String(value ?? '');
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function sanitizeBaseName(name) {
  const safe = String(name || 'file')
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return safe || 'file';
}

function extractJsonObjectText(rawText) {
  const text = String(rawText || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return text.slice(start, end + 1);
}

function normalizeAgentPayload(candidate, fallbackText = '') {
  const fallbackContent = String(fallbackText || '').trim() || 'No response from Anthropic';
  const type = String(candidate?.type || '').toLowerCase();
  const rawFormat = String(candidate?.format || '').toLowerCase();
  const content = typeof candidate?.content === 'string' ? candidate.content : fallbackContent;

  if (type !== 'text' && type !== 'file') {
    return { type: 'text', format: 'txt', content: fallbackContent };
  }

  if (type === 'file') {
    if (!supportedFileFormats.has(rawFormat)) {
      return { type: 'text', format: 'txt', content: fallbackContent };
    }
    return { type: 'file', format: rawFormat, content };
  }

  const format = rawFormat === 'md' ? 'md' : 'txt';
  return { type: 'text', format, content };
}

function parseAndValidateAgentJson(rawText) {
  const jsonText = extractJsonObjectText(rawText);
  if (!jsonText) {
    return normalizeAgentPayload({ type: 'text', format: 'txt', content: rawText }, rawText);
  }

  try {
    const parsed = JSON.parse(jsonText);
    return normalizeAgentPayload(parsed, rawText);
  } catch {
    return normalizeAgentPayload({ type: 'text', format: 'txt', content: rawText }, rawText);
  }
}

function extractAiNewsRowsFromRss(xmlText, limit = 10) {
  const parsed = rssParser.parse(xmlText);
  const rawItems = parsed?.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  return items.slice(0, limit).map((item) => {
    const source = typeof item.source === 'string' ? item.source : item.source?.['#text'] || '';
    return {
      title: item.title || '',
      source,
      publishedAt: item.pubDate || '',
      url: item.link || ''
    };
  });
}

async function searchAiNews(query = 'artificial intelligence', limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const rssRes = await fetch(rssUrl);
  if (!rssRes.ok) {
    throw new Error(`RSS request failed: ${rssRes.status}`);
  }

  const rssXml = await rssRes.text();
  const rows = extractAiNewsRowsFromRss(rssXml, safeLimit);
  return { query, items: rows, total: rows.length };
}

async function fetchUrlText(url, maxChars = 8000) {
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }

  const response = await fetch(parsedUrl.toString());
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  const raw = await response.text();
  const text = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const safeMax = Math.max(500, Math.min(Number(maxChars) || 8000, 20000));

  return {
    url: parsedUrl.toString(),
    content: plain.slice(0, safeMax),
    truncated: plain.length > safeMax
  };
}

function pickGmailToolName(tools = []) {
  const names = tools.map((tool) => tool?.name).filter(Boolean);
  const preferredPatterns = [
    /gmail.*(list|search|get).*(message|mail|email|thread|inbox)/i,
    /(list|search|get).*(message|mail|email|thread|inbox)/i,
    /gmail/i
  ];

  for (const pattern of preferredPatterns) {
    const match = names.find((name) => pattern.test(name));
    if (match) return match;
  }

  return names[0] || null;
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function summarizeToolResult(result) {
  if (result?.structuredContent) {
    return JSON.stringify(result.structuredContent).slice(0, 4000);
  }

  if (Array.isArray(result?.content)) {
    const textBlocks = result.content
      .filter((item) => item?.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .trim();
    if (textBlocks) return textBlocks.slice(0, 4000);
  }

  return JSON.stringify(result || {}).slice(0, 4000);
}

async function fetchGmailContextViaMcp() {
  const transport = new StdioClientTransport({
    command: connectionSettings.gmail.command,
    args: connectionSettings.gmail.args,
    env: process.env
  });
  const client = new McpClient({ name: 'duvo-agent', version: '1.0.0' });

  try {
    await withTimeout(client.connect(transport), 20000, 'Timeout while connecting to Gmail MCP');
    const toolsResult = await withTimeout(client.listTools(), 20000, 'Timeout while listing Gmail MCP tools');
    const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
    const toolName = pickGmailToolName(tools);

    if (!toolName) {
      throw new Error('No tools available from Gmail MCP server');
    }

    let toolCallResult;
    try {
      toolCallResult = await withTimeout(
        client.callTool({
          name: toolName,
          arguments: {
            query: 'newer_than:7d',
            maxResults: 5
          }
        }),
        20000,
        `Timeout while calling Gmail MCP tool ${toolName}`
      );
    } catch {
      toolCallResult = await withTimeout(
        client.callTool({ name: toolName, arguments: {} }),
        20000,
        `Timeout while calling Gmail MCP tool ${toolName}`
      );
    }

    return {
      toolName,
      contextText: summarizeToolResult(toolCallResult)
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function saveGeneratedFile({ fileName, format, content }) {
  const safeBaseName = sanitizeBaseName(fileName || 'generated-file');
  const timestamp = nowIso().replace(/[.:]/g, '-');
  const finalFileName = `${safeBaseName}-${timestamp}.${format}`;
  const filePath = path.join(generatedDir, finalFileName);

  await fs.mkdir(generatedDir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');

  return {
    name: finalFileName,
    format,
    url: `/files/${finalFileName}`
  };
}

function buildCsvFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('rows must be a non-empty array');
  }

  if (Array.isArray(rows[0])) {
    const matrix = rows;
    return `${matrix.map((line) => line.map(escapeCsvCell).join(',')).join('\n')}\n`;
  }

  const records = rows;
  const headers = Object.keys(records[0] || {});
  const lines = [headers.map(escapeCsvCell).join(',')];

  for (const record of records) {
    lines.push(headers.map((header) => escapeCsvCell(record?.[header])).join(','));
  }

  return `${lines.join('\n')}\n`;
}

function buildNewsCsv(rows) {
  const headers = ['title', 'source', 'published_at', 'url'];
  const lines = [headers.map(escapeCsvCell).join(',')];

  for (const row of rows) {
    lines.push([
      escapeCsvCell(row.title),
      escapeCsvCell(row.source),
      escapeCsvCell(row.publishedAt),
      escapeCsvCell(row.url)
    ].join(','));
  }

  return `${lines.join('\n')}\n`;
}

function looksLikeCsv(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;

  const firstLine = lines[0];
  return firstLine.includes(',') && lines.some((line) => line.includes(','));
}

async function generateAiNewsCsvFile() {
  const { items: rows } = await searchAiNews('artificial intelligence', 10);

  if (rows.length === 0) {
    throw new Error('No news entries found in RSS feed');
  }

  const timestamp = nowIso().replace(/[.:]/g, '-');
  const fileName = `ai-news-${timestamp}`;
  const csv = buildNewsCsv(rows);
  const file = await saveGeneratedFile({ fileName, format: 'csv', content: csv });

  return {
    fileName: file.name,
    downloadUrl: file.url,
    totalRows: rows.length
  };
}

function pruneRuns() {
  if (automationRuns.size <= maxStoredRuns) return;

  const sorted = Array.from(automationRuns.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const toDelete = sorted.slice(0, sorted.length - maxStoredRuns);
  for (const run of toDelete) {
    automationRuns.delete(run.id);
  }
}

function createAutomationRun(instruction) {
  const now = nowIso();
  const run = {
    id: randomUUID(),
    instruction,
    status: 'queued',
    steps: [],
    currentStepId: null,
    connections: {
      gmail: {
        enabled: connectionSettings.gmail.enabled,
        used: false,
        toolName: null,
        error: null
      }
    },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now
  };

  automationRuns.set(run.id, run);
  pruneRuns();
  return run;
}

function getAutomationRun(runId) {
  return automationRuns.get(runId) || null;
}

function toPublicRun(run) {
  return JSON.parse(JSON.stringify(run));
}

function updateRun(runId, updater) {
  const run = getAutomationRun(runId);
  if (!run) return null;
  updater(run);
  run.updatedAt = nowIso();
  return run;
}

function setRunStatus(runId, status) {
  updateRun(runId, (run) => {
    run.status = status;
  });
}

function startRunStep(runId, title, details = '') {
  const stepId = randomUUID();
  updateRun(runId, (run) => {
    run.steps.push({
      id: stepId,
      title,
      details,
      status: 'in_progress',
      startedAt: nowIso(),
      endedAt: null,
      error: null
    });
    run.currentStepId = stepId;
  });
  return stepId;
}

function completeRunStep(runId, stepId, details = '') {
  updateRun(runId, (run) => {
    const step = run.steps.find((item) => item.id === stepId);
    if (!step) return;
    step.status = 'completed';
    if (details) step.details = details;
    step.endedAt = nowIso();
    if (run.currentStepId === stepId) {
      run.currentStepId = null;
    }
  });
}

function failRunStep(runId, stepId, errorMessage) {
  updateRun(runId, (run) => {
    const step = run.steps.find((item) => item.id === stepId);
    if (!step) return;
    step.status = 'failed';
    step.error = String(errorMessage || 'Unknown error');
    step.endedAt = nowIso();
    if (run.currentStepId === stepId) {
      run.currentStepId = null;
    }
  });
}

async function executeInstruction(instruction, hooks = {}) {
  const onStepStart = hooks.onStepStart || (() => null);
  const onStepComplete = hooks.onStepComplete || (() => {});
  const onStepFail = hooks.onStepFail || (() => {});
  const onConnectionUpdate = hooks.onConnectionUpdate || (() => {});

  const stepValidate = onStepStart('Validate input', 'Checking instruction and configuration');
  if (!anthropic) {
    onStepFail(stepValidate, 'Anthropic key is missing');
    throw new Error('Anthropic is not configured. Set ANTHROPIC_KEY (or ANTHROPIC_API_KEY) in backend/.env');
  }
  onStepComplete(stepValidate, 'Input is valid');

  let effectiveInstruction = instruction;
  if (hooks.useGmailConnection) {
    const stepGmail = onStepStart('Read upstream data (Gmail MCP)', 'Connecting to Gmail MCP server');
    try {
      const gmailContext = await fetchGmailContextViaMcp();
      effectiveInstruction =
        `${instruction}\n\nConnected Gmail context (from MCP tool ${gmailContext.toolName}):\n` +
        `${gmailContext.contextText}`;
      onConnectionUpdate({
        gmail: { used: true, toolName: gmailContext.toolName, error: null }
      });
      onStepComplete(stepGmail, `Fetched upstream context using ${gmailContext.toolName}`);
    } catch (gmailError) {
      const message = gmailError instanceof Error ? gmailError.message : 'Gmail MCP failed';
      onConnectionUpdate({
        gmail: { used: false, toolName: null, error: message }
      });
      onStepFail(stepGmail, message);
    }
  }

  const jsonContractPrompt =
    'Return only valid JSON object with this exact shape: {"type":"text|file","format":"file format","content":"simple text | file content"}. ' +
    'Rules: no markdown, no code fences, no extra keys. ' +
    'If type is "text", set format to "txt" or "md". ' +
    'If type is "file", format must be one of: csv, txt, md, and content must be full file content. ' +
    'For format="csv", content must be valid CSV text only: first line headers, next lines data rows, comma-separated, no explanations. ' +
    'Use available tools when user asks for web/internet/latest news information. ' +
    `Always finish by calling tool "${agentResponseToolName}".`;

  const tools = [
    {
      name: webSearchToolName,
      description: 'Search latest AI news from Google News RSS.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      name: fetchUrlToolName,
      description: 'Fetch plain text from a web URL.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          maxChars: { type: 'number' }
        },
        required: ['url'],
        additionalProperties: false
      }
    },
    {
      name: agentResponseToolName,
      description:
        'Return the final result in strict JSON contract with fields type, format, content.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'file'] },
          format: { type: 'string', enum: ['txt', 'md', 'csv'] },
          content: { type: 'string' }
        },
        required: ['type', 'format', 'content'],
        additionalProperties: false
      }
    }
  ];

  const stepModel = onStepStart('Run LLM workflow', 'Starting tool-enabled reasoning loop');

  const messages = [{ role: 'user', content: effectiveInstruction }];
  let finalAgent = null;
  let fallbackText = '';
  let latestNewsItems = [];

  for (let i = 0; i < 8; i += 1) {
    const stepIteration = onStepStart('LLM iteration', `Iteration ${i + 1}`);

    const completion = await anthropic.messages.create({
      model: anthropicModel,
      max_tokens: anthropicMaxTokens,
      system: jsonContractPrompt,
      tools,
      tool_choice: { type: 'auto' },
      messages
    });

    const rawResponseText = completion.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .trim();

    if (rawResponseText) {
      fallbackText = rawResponseText;
    }

    const toolUses = completion.content.filter((item) => item.type === 'tool_use');
    messages.push({ role: 'assistant', content: completion.content });

    if (toolUses.length === 0) {
      finalAgent = parseAndValidateAgentJson(rawResponseText);
      onStepComplete(stepIteration, 'Model returned direct response');
      break;
    }

    const toolResults = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === agentResponseToolName) {
        finalAgent = normalizeAgentPayload(toolUse.input, fallbackText);
        continue;
      }

      const toolStep = onStepStart('Tool execution', `Calling ${toolUse.name}`);
      try {
        if (toolUse.name === webSearchToolName) {
          const result = await searchAiNews(toolUse.input?.query, toolUse.input?.limit);
          latestNewsItems = Array.isArray(result.items) ? result.items : latestNewsItems;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          });
          onStepComplete(toolStep, `${toolUse.name} returned ${result.total} items`);
          continue;
        }

        if (toolUse.name === fetchUrlToolName) {
          const result = await fetchUrlText(toolUse.input?.url, toolUse.input?.maxChars);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          });
          onStepComplete(toolStep, `${toolUse.name} succeeded`);
          continue;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` }),
          is_error: true
        });
        onStepFail(toolStep, `Unknown tool: ${toolUse.name}`);
      } catch (toolError) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            error: toolError instanceof Error ? toolError.message : 'Tool execution failed'
          }),
          is_error: true
        });
        onStepFail(toolStep, toolError instanceof Error ? toolError.message : 'Tool failed');
      }
    }

    onStepComplete(stepIteration, `Processed ${toolUses.length} tool call(s)`);

    if (finalAgent) {
      break;
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  let agent =
    finalAgent ||
    normalizeAgentPayload({ type: 'text', format: 'txt', content: fallbackText }, fallbackText);

  if (agent.type === 'file' && agent.format === 'csv' && !looksLikeCsv(agent.content)) {
    if (latestNewsItems.length > 0) {
      agent = {
        type: 'file',
        format: 'csv',
        content: buildNewsCsv(latestNewsItems)
      };
    } else {
      agent = {
        type: 'text',
        format: 'txt',
        content: 'Model returned invalid CSV content and no structured rows were available to recover.'
      };
    }
  }

  onStepComplete(stepModel, 'LLM workflow completed');

  if (agent.type === 'file') {
    const stepSave = onStepStart('Save generated file', `Persisting .${agent.format} output`);
    const generatedFile = await saveGeneratedFile({
      fileName: 'agent-output',
      format: agent.format,
      content: agent.content
    });
    onStepComplete(stepSave, `Saved ${generatedFile.name}`);

    return {
      response: `Generated file: **${generatedFile.name}**`,
      agent,
      file: generatedFile,
      timestamp: nowIso()
    };
  }

  return {
    response: agent.content || 'No response from Anthropic',
    agent,
    timestamp: nowIso()
  };
}

async function processAutomationRun(runId, instruction, options = {}) {
  setRunStatus(runId, 'running');

  try {
    const result = await executeInstruction(instruction, {
      useGmailConnection: Boolean(options.useGmailConnection),
      onStepStart: (title, details) => startRunStep(runId, title, details),
      onStepComplete: (stepId, details) => completeRunStep(runId, stepId, details),
      onStepFail: (stepId, errorMessage) => failRunStep(runId, stepId, errorMessage),
      onConnectionUpdate: (partial) => {
        updateRun(runId, (run) => {
          run.connections.gmail.used = Boolean(partial?.gmail?.used);
          run.connections.gmail.toolName = partial?.gmail?.toolName || null;
          run.connections.gmail.error = partial?.gmail?.error || null;
        });
      }
    });

    updateRun(runId, (run) => {
      run.status = 'completed';
      run.result = result;
      run.error = null;
    });
  } catch (error) {
    updateRun(runId, (run) => {
      run.status = 'failed';
      run.result = null;
      run.error = error instanceof Error ? error.message : 'Automation failed';
    });
  }
}

app.post('/api/files/generate', async (req, res) => {
  const format = String(req.body?.format || '').toLowerCase();
  const baseName = sanitizeBaseName(req.body?.fileName || `generated-${Date.now()}`);
  const content = req.body?.content;
  const rows = req.body?.rows;

  if (!supportedFileFormats.has(format)) {
    return res.status(400).json({
      ok: false,
      message: 'Unsupported format. Use one of: csv, txt, md'
    });
  }

  let fileContent = '';
  try {
    if (format === 'csv') {
      if (typeof content === 'string' && content.trim().length > 0) {
        fileContent = content.endsWith('\n') ? content : `${content}\n`;
      } else {
        fileContent = buildCsvFromRows(rows);
      }
    } else {
      if (typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({
          ok: false,
          message: `${format} generation requires non-empty string content`
        });
      }
      fileContent = content;
    }
  } catch (error) {
    return res.status(400).json({
      ok: false,
      message: `Invalid payload: ${error instanceof Error ? error.message : 'unknown error'}`
    });
  }

  const file = await saveGeneratedFile({
    fileName: baseName,
    format,
    content: fileContent
  });

  return res.json({
    ok: true,
    file,
    timestamp: nowIso()
  });
});

app.get('/api/connections', (_req, res) => {
  return res.json({
    ok: true,
    connections: getConnectionState()
  });
});

app.get('/api/connections/gmail', (_req, res) => {
  return res.json({
    ok: true,
    gmail: getConnectionState().gmail
  });
});

app.post('/api/connections/gmail', (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      ok: false,
      message: 'enabled must be boolean'
    });
  }

  connectionSettings.gmail.enabled = enabled;
  connectionSettings.gmail.updatedAt = nowIso();

  return res.json({
    ok: true,
    gmail: getConnectionState().gmail
  });
});

app.post('/api/automations/run', (req, res) => {
  const instruction = req.body?.instruction;
  const useGmailConnection =
    typeof req.body?.options?.useGmailConnection === 'boolean'
      ? req.body.options.useGmailConnection
      : connectionSettings.gmail.enabled;

  if (typeof instruction !== 'string' || instruction.trim().length === 0) {
    return res.status(400).json({
      ok: false,
      message: 'Instruction is required'
    });
  }

  const run = createAutomationRun(instruction.trim());
  updateRun(run.id, (targetRun) => {
    targetRun.connections.gmail.enabled = useGmailConnection;
  });

  processAutomationRun(run.id, run.instruction, { useGmailConnection }).catch((error) => {
    updateRun(run.id, (targetRun) => {
      targetRun.status = 'failed';
      targetRun.error = error instanceof Error ? error.message : 'Automation failed';
    });
  });

  return res.status(202).json({
    ok: true,
    run: toPublicRun(run)
  });
});

app.get('/api/automations/:id', (req, res) => {
  const run = getAutomationRun(req.params.id);

  if (!run) {
    return res.status(404).json({
      ok: false,
      message: 'Automation run not found'
    });
  }

  return res.json({
    ok: true,
    run: toPublicRun(run)
  });
});

app.post('/api/agent', async (req, res) => {
  const instruction = req.body?.instruction;

  if (typeof instruction !== 'string' || instruction.trim().length === 0) {
    return res.status(400).json({
      ok: false,
      message: 'Instruction is required'
    });
  }

  try {
    const result = await executeInstruction(instruction.trim());
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Anthropic API error:', error);
    return res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to get response from Anthropic'
    });
  }
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
