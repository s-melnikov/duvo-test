import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Download, LoaderCircle, Send, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Button } from '@/components/ui/button';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

type AgentPayload = {
  type?: 'text' | 'file';
  format?: string;
  content?: string;
};

type FilePayload = {
  name?: string;
  url?: string;
  format?: string;
};

type AutomationResult = {
  response?: string;
  agent?: AgentPayload;
  file?: FilePayload;
  timestamp?: string;
};

type AutomationStep = {
  id: string;
  title: string;
  details: string;
  status: 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  endedAt: string | null;
  error: string | null;
};

type AutomationRun = {
  id: string;
  instruction: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  steps: AutomationStep[];
  currentStepId: string | null;
  connections: {
    gmail: {
      enabled: boolean;
      used: boolean;
      toolName: string | null;
      error: string | null;
    };
  };
  result: AutomationResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type GmailConnectionState = {
  enabled: boolean;
  command?: string;
  args?: string[];
  updatedAt?: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  type?: 'text' | 'file';
  format?: string;
  file?: {
    name: string;
    url: string;
    format?: string;
  };
};

function formatTime(iso: string | null | undefined) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString();
}

function statusClassName(status: AutomationRun['status'] | AutomationStep['status']) {
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  if (status === 'failed') return 'bg-rose-100 text-rose-700 border-rose-200';
  if (status === 'running' || status === 'in_progress') return 'bg-blue-100 text-blue-700 border-blue-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

export default function App() {
  const [instruction, setInstruction] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [automationRun, setAutomationRun] = useState<AutomationRun | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [gmailConnection, setGmailConnection] = useState<GmailConnectionState | null>(null);
  const [isUpdatingConnection, setIsUpdatingConnection] = useState(false);
  const handledRunIdsRef = useRef(new Set<string>());

  const isRunInProgress = useMemo(() => {
    if (!automationRun) return false;
    return automationRun.status === 'queued' || automationRun.status === 'running';
  }, [automationRun]);

  function appendAgentMessageFromResult(result: AutomationResult | null) {
    if (!result) return;

    const nextMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'agent',
      type: result.agent?.type || (result.file?.name ? 'file' : 'text'),
      text: result.agent?.content || result.response || 'No response',
      format: result.agent?.format,
      file:
        result.file?.name && result.file?.url
          ? {
              name: result.file.name,
              url: result.file.url,
              format: result.file.format
            }
          : undefined
    };

    setMessages((prev) => [...prev, nextMessage]);
  }

  useEffect(() => {
    const loadConnections = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/connections/gmail`);
        if (!res.ok) return;
        const data = (await res.json()) as { gmail?: GmailConnectionState };
        if (data.gmail) {
          setGmailConnection(data.gmail);
        }
      } catch {
        // Ignore initial connection loading failures.
      }
    };

    loadConnections();
  }, []);

  useEffect(() => {
    if (!automationRun) return;

    if (automationRun.status === 'completed' && !handledRunIdsRef.current.has(automationRun.id)) {
      handledRunIdsRef.current.add(automationRun.id);
      appendAgentMessageFromResult(automationRun.result);
      return;
    }

    if (automationRun.status === 'failed' && !handledRunIdsRef.current.has(automationRun.id)) {
      handledRunIdsRef.current.add(automationRun.id);
      setError(automationRun.error || 'Automation failed');
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          type: 'text',
          format: 'txt',
          text: `Automation failed: ${automationRun.error || 'Unknown error'}`
        }
      ]);
    }
  }, [automationRun]);

  useEffect(() => {
    if (!automationRun || !isRunInProgress) return;

    const intervalId = window.setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/automations/${automationRun.id}`);
        if (!res.ok) return;

        const data = (await res.json()) as { run?: AutomationRun };
        if (data.run) {
          setAutomationRun(data.run);
        }
      } catch {
        // Keep polling on transient failures.
      }
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [automationRun, isRunInProgress]);

  async function toggleGmailConnection() {
    if (!gmailConnection || isUpdatingConnection) return;
    setIsUpdatingConnection(true);
    setError('');

    try {
      const res = await fetch(`${API_BASE_URL}/api/connections/gmail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !gmailConnection.enabled })
      });

      if (!res.ok) {
        throw new Error('Failed to update connection');
      }

      const data = (await res.json()) as { gmail?: GmailConnectionState };
      if (data.gmail) {
        setGmailConnection(data.gmail);
      }
    } catch {
      setError('Failed to update Gmail MCP connection');
    } finally {
      setIsUpdatingConnection(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed || isSubmitting || isRunInProgress) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: trimmed,
      type: 'text',
      format: 'txt'
    };

    setMessages((prev) => [...prev, userMessage]);
    setInstruction('');
    setError('');
    setIsSubmitting(true);

    try {
      const res = await fetch(`${API_BASE_URL}/api/automations/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: trimmed,
          options: {
            useGmailConnection: Boolean(gmailConnection?.enabled)
          }
        })
      });

      if (!res.ok) {
        throw new Error('Failed to start automation');
      }

      const data = (await res.json()) as { run?: AutomationRun };
      if (!data.run) {
        throw new Error('Automation run was not returned');
      }

      setAutomationRun(data.run);
    } catch {
      setError('Failed to start automation');
    } finally {
      setIsSubmitting(false);
    }
  }

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!isSubmitting && !isRunInProgress && instruction.trim().length > 0) {
        event.currentTarget.form?.requestSubmit();
      }
    }
  }

  return (
    <main className="container py-16">
      <section className="mx-auto max-w-3xl rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Simple AI Chat</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Send an instruction to your agent and observe automation step-by-step.
        </p>

        <section className="mt-4 rounded-xl border bg-secondary/20 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Connected Data Source</p>
              <p className="text-xs text-muted-foreground">
                Gmail MCP server {gmailConnection?.enabled ? 'enabled' : 'disabled'}.
              </p>
            </div>
            <Button type="button" variant={gmailConnection?.enabled ? 'secondary' : 'outline'} onClick={toggleGmailConnection} disabled={isUpdatingConnection || isRunInProgress}>
              {isUpdatingConnection ? 'Updating...' : gmailConnection?.enabled ? 'Disable Gmail MCP' : 'Enable Gmail MCP'}
            </Button>
          </div>
        </section>

        {automationRun ? (
          <section className="mt-4 rounded-xl border bg-secondary/30 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Automation Run</p>
              <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClassName(automationRun.status)}`}>
                {automationRun.status}
              </span>
              <span className="text-xs text-muted-foreground">#{automationRun.id.slice(0, 8)}</span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border px-2 py-0.5">
                Gmail MCP requested: {automationRun.connections.gmail.enabled ? 'yes' : 'no'}
              </span>
              <span className="rounded-full border px-2 py-0.5">
                Gmail MCP used: {automationRun.connections.gmail.used ? 'yes' : 'no'}
              </span>
              {automationRun.connections.gmail.toolName ? (
                <span className="rounded-full border px-2 py-0.5">
                  Tool: {automationRun.connections.gmail.toolName}
                </span>
              ) : null}
            </div>
            {automationRun.connections.gmail.error ? (
              <p className="mt-2 text-xs text-destructive">Gmail MCP error: {automationRun.connections.gmail.error}</p>
            ) : null}

            <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-1">
              {automationRun.steps.length === 0 ? (
                <p className="text-xs text-muted-foreground">Waiting for first step...</p>
              ) : (
                automationRun.steps.map((step) => (
                  <article key={step.id} className="rounded-lg border bg-background p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium">{step.title}</p>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${statusClassName(step.status)}`}>
                        {step.status}
                      </span>
                    </div>
                    {step.details ? <p className="mt-1 text-xs text-muted-foreground">{step.details}</p> : null}
                    {step.error ? <p className="mt-1 text-xs text-destructive">{step.error}</p> : null}
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {formatTime(step.startedAt)}{step.endedAt ? ` -> ${formatTime(step.endedAt)}` : ''}
                    </p>
                  </article>
                ))
              )}
            </div>
          </section>
        ) : null}

        <div className="mt-6 h-[360px] space-y-3 overflow-y-auto rounded-xl border bg-background p-4">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages yet.</p>
          ) : (
            messages.map((message) => (
              <article key={message.id} className="rounded-lg border p-3">
                <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                  {message.role === 'user' ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                  {message.role}
                </p>
                {message.type === 'file' ? (
                  <div className="space-y-2 text-sm">
                    <p className="text-muted-foreground">
                      Generated file format: <span className="font-medium uppercase">{message.format || 'unknown'}</span>
                    </p>
                  </div>
                ) : (
                  <div className="markdown-body text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
                  </div>
                )}
                {message.type === 'file' && message.file ? (
                  <div className="mt-3">
                    <Button asChild size="sm" variant="outline">
                      <a
                        href={message.file.url.startsWith('http') ? message.file.url : `${API_BASE_URL}${message.file.url}`}
                        download={message.file.name}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Download className="h-4 w-4" />
                        Download {message.file.format?.toUpperCase() || 'File'}
                      </a>
                    </Button>
                  </div>
                ) : null}
              </article>
            ))
          )}
          {isRunInProgress ? (
            <article className="rounded-lg border p-3">
              <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                <Bot className="h-3.5 w-3.5" />
                agent
              </p>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                <span>
                  {automationRun?.currentStepId
                    ? automationRun.steps.find((item) => item.id === automationRun.currentStepId)?.title || 'Processing'
                    : 'Processing'}
                </span>
              </div>
            </article>
          ) : null}
        </div>

        <form className="mt-4 space-y-3" onSubmit={onSubmit}>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={onTextareaKeyDown}
            placeholder="Type instruction for agent..."
            rows={5}
            className="w-full resize-y rounded-md border bg-background p-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={isSubmitting || isRunInProgress || instruction.trim().length === 0}>
            <Send className="mr-2 h-4 w-4" />
            {isSubmitting ? 'Starting...' : isRunInProgress ? 'Automation running...' : 'Send request'}
          </Button>
        </form>
      </section>
    </main>
  );
}
