export interface Env {
  AI: Ai;
  CHAT_ROOM: DurableObjectNamespace;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ChatRequest = {
  sessionId?: string;
  message?: string;
};

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const SYSTEM_PROMPT =
  'You are Cloudflare Atlas, a concise assistant for building and debugging Cloudflare apps. ' +
  'Be practical, ask clarifying questions when needed, and keep answers short unless asked.';
const MAX_HISTORY = 18;
const AI_RETRIES = 2;
const AI_RETRY_DELAY_MS = 400;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
      }

      const body = (await request.json().catch(() => null)) as ChatRequest | null;
      if (!body?.sessionId || !body?.message) {
        return Response.json({ error: 'sessionId and message are required' }, { status: 400 });
      }

      const id = env.CHAT_ROOM.idFromName(body.sessionId);
      const stub = env.CHAT_ROOM.get(id);
      const historyResponse = await stub.fetch('https://do/history');
      const historyPayload = (await historyResponse.json().catch(() => null)) as
        | { messages?: ChatMessage[] }
        | null;
      const history = historyPayload?.messages ?? [];
      const trimmed = history.slice(-MAX_HISTORY);
      trimmed.push({ role: 'user', content: body.message });

      let aiResult: unknown;
      try {
        aiResult = await runWithRetry(
          () =>
            env.AI.run(MODEL, {
              messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...trimmed],
            }),
          AI_RETRIES,
          AI_RETRY_DELAY_MS
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return Response.json(
          { error: 'AI request failed', detail },
          { status: 502 }
        );
      }

      const assistantText = extractText(aiResult);
      trimmed.push({ role: 'assistant', content: assistantText });

      await stub.fetch('https://do/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: trimmed }),
      });

      return Response.json({ response: assistantText, messages: trimmed });
    }

    if (url.pathname === '/api/history') {
      if (request.method !== 'GET') {
        return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
      }

      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return Response.json({ error: 'sessionId is required' }, { status: 400 });
      }

      const id = env.CHAT_ROOM.idFromName(sessionId);
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch('https://do/history');
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};

export class ChatRoom {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/history') {
      if (request.method === 'POST') {
        const body = (await request.json().catch(() => null)) as
          | { messages?: ChatMessage[] }
          | null;
        const messages = body?.messages ?? [];
        await this.state.storage.put('messages', messages);
        return Response.json({ ok: true });
      }

      const messages = (await this.state.storage.get<ChatMessage[]>('messages')) ?? [];
      return Response.json({ messages });
    }

    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
}

function extractText(result: unknown): string {
  if (!result) return 'No response generated.';
  if (typeof result === 'string') return result;

  const asRecord = result as Record<string, unknown>;
  if (typeof asRecord.response === 'string') return asRecord.response;
  if (typeof asRecord.result === 'string') return asRecord.result;
  if (typeof asRecord.output_text === 'string') return asRecord.output_text;

  const choices = asRecord.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === 'string') return message.content;

  try {
    return JSON.stringify(result);
  } catch {
    return 'Response unavailable.';
  }
}

async function runWithRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await sleep(delayMs * (attempt + 1));
      attempt += 1;
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
