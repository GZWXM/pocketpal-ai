/**
 * Hermes remote backend client.
 *
 * Talks to a remote `hermes api_server` over its OpenAI-compatible
 * `POST /v1/chat/completions` SSE endpoint. On top of the standard
 * `data: {...}` chunks the server emits two named events:
 *
 *   event: hermes.reasoning      data: {"text": "..."}
 *   event: hermes.tool.progress  data: {"tool","emoji","label","toolCallId","status"}
 *
 * Unlike `openai.ts` the whole tool loop lives on the server, so this
 * client only has to report progress: it never executes a tool and never
 * feeds a `role: 'tool'` message back.
 *
 * Transport: a real `fetch` + `ReadableStream` reader is used when the
 * runtime can support it. React Native's `fetch` exposes no response body
 * stream, so on device the client transparently falls back to the
 * XMLHttpRequest `onprogress` transport that `eventStream.ts` established
 * (see `supportsFetchStream()`), keeping the SSE framing identical.
 */

import type {AgentToolCall} from '../utils/types';
import {
  CONNECTION_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  buildHeaders,
  normalizeUrl,
  resolveTimeout,
} from './http';
import {encodeMessagesForRemote} from './openai';

/** Custom event names the Hermes server streams alongside the standard ones. */
export const HERMES_EVENT_REASONING = 'hermes.reasoning';
export const HERMES_EVENT_TOOL_PROGRESS = 'hermes.tool.progress';

/** Which HTTP transport to use. `auto` prefers fetch streaming when available. */
export type HermesTransport = 'auto' | 'fetch' | 'xhr';

/**
 * Error classification. Every failure mode the store has to react to
 * differently gets a kind of its own so a surface can word it without
 * string matching.
 */
export type HermesErrorKind =
  | 'network'
  | 'auth'
  | 'server'
  | 'timeout'
  | 'aborted'
  | 'protocol';

/** Typed transport/protocol failure. `serverMessage` is the server's own words. */
export class HermesStreamError extends Error {
  readonly kind: HermesErrorKind;
  readonly status?: number;
  readonly serverMessage?: string;

  constructor(
    kind: HermesErrorKind,
    message: string,
    extra?: {status?: number; serverMessage?: string},
  ) {
    super(message);
    this.name = 'HermesStreamError';
    this.kind = kind;
    this.status = extra?.status;
    this.serverMessage = extra?.serverMessage;
  }
}

/** Progress report for one server-side tool execution. */
export interface HermesToolProgress {
  tool: string;
  emoji?: string;
  label?: string;
  toolCallId?: string;
  status: string;
}

/** One OpenAI-style content part (text or an image attachment). */
export interface HermesContentPart {
  type: string;
  text?: string;
  image_url?: {url?: string};
}

/** Wire message, in OpenAI shape. `content` is an array when the turn carries images. */
export interface HermesWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | HermesContentPart[];
}

export interface HermesStreamParams {
  /** Base server URL, with or without a trailing `/v1`. */
  serverUrl: string;
  apiKey?: string;
  model?: string;
  messages: HermesWireMessage[];
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  transport?: HermesTransport;
  temperature?: number;
  maxTokens?: number;
  /** Extra body keys forwarded verbatim (server-side tuning). */
  extraBody?: Record<string, unknown>;
  /**
   * Stable session id sent as `X-Hermes-Session-Id`. The server loads that
   * session's history and appends this turn to it, which is what makes
   * `GET /api/sessions/{id}/messages` able to return the whole conversation.
   */
  sessionId?: string;
}

export interface HermesStreamHandlers {
  /** Headers arrived; the server accepted the request. */
  onOpen?: () => void;
  /** Visible answer text delta. */
  onContent?: (delta: string) => void;
  /** Thinking-process delta (`hermes.reasoning`). */
  onReasoning?: (delta: string) => void;
  /** Tool execution progress (`hermes.tool.progress`). */
  onToolProgress?: (progress: HermesToolProgress) => void;
  /** Running snapshot of a standard OpenAI `delta.tool_calls` fragment. */
  onToolCall?: (call: AgentToolCall) => void;
}

/**
 * What arrived on the stream. `interrupted` is true when the caller
 * aborted: the partial text is kept, matching `streamChatCompletion`.
 */
export interface HermesStreamResult {
  content: string;
  reasoning: string;
  /** Progress events in arrival order. */
  toolProgress: HermesToolProgress[];
  /** Fully assembled `delta.tool_calls`, when the server emitted any. */
  toolCalls: AgentToolCall[];
  finishReason?: string;
  interrupted: boolean;
}

const DEFAULT_MODEL = 'hermes';

/** One parsed SSE frame: its `event:` name and its joined `data:` payload. */
interface SSEFrame {
  event: string;
  data: string;
}

/**
 * SSE framing that keeps `event:` names. `sseParser.parseSSELine` drops
 * them, which is fine for OpenAI but would erase the Hermes custom events,
 * so the frame parser is local to this file.
 *
 * Frames are separated by a blank line; a `\r\n` split across two chunks is
 * held back rather than read as one.
 */
class HermesSSEDecoder {
  private buffer = '';

  push(chunk: string): SSEFrame[] {
    this.buffer += chunk;
    let heldCR = '';
    if (this.buffer.endsWith('\r')) {
      heldCR = '\r';
      this.buffer = this.buffer.slice(0, -1);
    }
    const normalized = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split('\n\n');
    this.buffer = (blocks.pop() ?? '') + heldCR;
    const frames: SSEFrame[] = [];
    for (const block of blocks) {
      const frame = parseFrame(block);
      if (frame) {
        frames.push(frame);
      }
    }
    return frames;
  }

  /** Everything left when the stream ends without a trailing blank line. */
  flush(): SSEFrame[] {
    const rest = this.buffer;
    this.buffer = '';
    const frame = parseFrame(rest);
    return frame ? [frame] : [];
  }
}

function parseFrame(block: string): SSEFrame | null {
  let event = '';
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) {
      continue; // empty padding or a heartbeat comment
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      // A single optional space after the colon belongs to the framing.
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  if (!dataLines.length) {
    return null;
  }
  return {event: event || 'message', data: dataLines.join('\n')};
}

/**
 * The server's own error text, bounded. Kept short because it ends up in a
 * user-facing message.
 */
function extractServerMessage(bodyText: string): string | undefined {
  if (!bodyText) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(bodyText);
    const message =
      parsed?.error?.message ??
      parsed?.message ??
      parsed?.error ??
      parsed?.detail;
    if (typeof message === 'string' && message.trim()) {
      return message.trim().slice(0, 300);
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  const trimmed = bodyText.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

/** Map a non-2xx answer onto the store's error kinds. */
function httpError(status: number, bodyText: string): HermesStreamError {
  const serverMessage = extractServerMessage(bodyText);
  if (status === 401 || status === 403) {
    return new HermesStreamError(
      'auth',
      'Unauthorized: invalid or missing API key',
      {status, serverMessage},
    );
  }
  if (status >= 500) {
    return new HermesStreamError('server', `Server error: ${status}`, {
      status,
      serverMessage,
    });
  }
  return new HermesStreamError('server', `Request failed: ${status}`, {
    status,
    serverMessage,
  });
}

function abortedError(): HermesStreamError {
  return new HermesStreamError('aborted', 'Completion aborted');
}

/**
 * True when the runtime can stream a fetch body. Hermes ships no
 * `TextDecoder`, so this is false on device and the XHR transport runs —
 * the same reason `eventStream.ts` exists.
 */
export function supportsFetchStream(): boolean {
  return (
    typeof fetch === 'function' &&
    typeof AbortController === 'function' &&
    typeof (globalThis as any).TextDecoder === 'function'
  );
}

function resolveTransport(
  transport: HermesTransport | undefined,
): 'fetch' | 'xhr' {
  if (transport === 'fetch') {
    return 'fetch';
  }
  if (transport === 'xhr') {
    return 'xhr';
  }
  return supportsFetchStream() ? 'fetch' : 'xhr';
}

/** Endpoint for the chat completions call, tolerating a `/v1` suffix. */
export function hermesChatUrl(serverUrl: string): string {
  return `${normalizeUrl(serverUrl)}/v1/chat/completions`;
}

function buildRequestBody(params: HermesStreamParams): string {
  const body: Record<string, unknown> = {
    model: params.model || DEFAULT_MODEL,
    messages: params.messages,
    stream: true,
  };
  if (typeof params.temperature === 'number') {
    body.temperature = params.temperature;
  }
  if (typeof params.maxTokens === 'number') {
    body.max_tokens = params.maxTokens;
  }
  return JSON.stringify({...params.extraBody, ...body});
}

/**
 * Per-stream accumulator. Named events and standard chunks both land here
 * so the two transports share one code path and one result shape.
 */
class HermesStreamAccumulator {
  content = '';
  reasoning = '';
  finishReason: string | undefined;
  readonly toolProgress: HermesToolProgress[] = [];
  private readonly toolCallFragments = new Map<
    number,
    {id: string; name: string; args: string[]}
  >();

  constructor(private readonly handlers: HermesStreamHandlers) {}

  /** Feed one frame. Throws a typed error for server-side error frames. */
  accept(frame: SSEFrame): void {
    const data = frame.data.trim();
    if (!data) {
      return;
    }
    if (data === '[DONE]') {
      return;
    }
    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      // A non-JSON payload is a keep-alive we do not model; ignore it.
      return;
    }
    if (frame.event === HERMES_EVENT_REASONING) {
      this.addReasoning(
        typeof payload?.text === 'string' ? payload.text : undefined,
      );
      return;
    }
    if (frame.event === HERMES_EVENT_TOOL_PROGRESS) {
      this.addToolProgress(payload);
      return;
    }
    if (frame.event !== 'message') {
      // An event this client does not model yet: never fatal.
      return;
    }
    if (payload?.error) {
      throw new HermesStreamError(
        'server',
        extractServerMessage(data) ?? 'Server returned an error',
        {serverMessage: extractServerMessage(data)},
      );
    }
    this.acceptChunk(payload);
  }

  private acceptChunk(payload: any): void {
    const choice = payload?.choices?.[0];
    if (!choice) {
      return;
    }
    const delta = choice.delta ?? {};
    // Servers disagree on the reasoning field name; accept both.
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) {
      this.addReasoning(reasoning);
    }
    if (typeof delta.content === 'string' && delta.content) {
      this.content += delta.content;
      this.handlers.onContent?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      this.acceptToolCallFragments(delta.tool_calls);
    }
    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }
  }

  private addReasoning(text: string | undefined): void {
    if (!text) {
      return;
    }
    this.reasoning += text;
    this.handlers.onReasoning?.(text);
  }

  private addToolProgress(payload: any): void {
    const tool = typeof payload?.tool === 'string' ? payload.tool : 'tool';
    const progress: HermesToolProgress = {
      tool,
      status: typeof payload?.status === 'string' ? payload.status : 'running',
    };
    if (typeof payload?.emoji === 'string') {
      progress.emoji = payload.emoji;
    }
    if (typeof payload?.label === 'string') {
      progress.label = payload.label;
    }
    if (typeof payload?.toolCallId === 'string') {
      progress.toolCallId = payload.toolCallId;
    }
    this.toolProgress.push(progress);
    this.handlers.onToolProgress?.(progress);
  }

  private acceptToolCallFragments(fragments: any[]): void {
    for (const fragment of fragments) {
      if (typeof fragment?.index !== 'number') {
        continue;
      }
      const entry = this.toolCallFragments.get(fragment.index) ?? {
        id: '',
        name: '',
        args: [] as string[],
      };
      if (fragment.id) {
        entry.id = fragment.id;
      }
      if (fragment.function?.name) {
        entry.name = fragment.function.name;
      }
      const argsDelta: string = fragment.function?.arguments ?? '';
      if (argsDelta) {
        entry.args.push(argsDelta);
      }
      this.toolCallFragments.set(fragment.index, entry);
      // The consumer only reads `function.name` mid-stream; full arguments
      // are assembled once at the end (see `assembleToolCalls`).
      this.handlers.onToolCall?.({
        id: entry.id || `hermes-tool-${fragment.index}`,
        type: 'function',
        function: {name: entry.name, arguments: argsDelta},
      });
    }
  }

  /** Final tool calls, ordered by stream index, arguments joined once. */
  assembleToolCalls(): AgentToolCall[] {
    return Array.from(this.toolCallFragments.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, entry]) => ({
        id: entry.id || `hermes-tool-${index}`,
        type: 'function' as const,
        function: {name: entry.name, arguments: entry.args.join('')},
      }));
  }

  snapshot(interrupted: boolean): HermesStreamResult {
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolProgress: this.toolProgress,
      toolCalls: this.assembleToolCalls(),
      finishReason: this.finishReason,
      interrupted,
    };
  }
}

/**
 * Stream a chat completion from a Hermes server.
 *
 * Resolves with whatever arrived; a caller abort resolves with
 * `interrupted: true` rather than rejecting, so partial text survives.
 * Real failures reject with a {@link HermesStreamError}.
 */
export async function streamHermesChat(
  params: HermesStreamParams,
  handlers: HermesStreamHandlers = {},
): Promise<HermesStreamResult> {
  const url = hermesChatUrl(params.serverUrl);
  const headers = buildHeaders(params.apiKey);
  headers.Accept = 'text/event-stream';
  if (params.sessionId) {
    headers['X-Hermes-Session-Id'] = params.sessionId;
  }
  const body = buildRequestBody({
    ...params,
    // A remote server cannot read the device filesystem: inline local image
    // attachments as data: URIs before the body is serialized.
    messages: await encodeMessagesForRemote(params.messages),
  });
  const connectTimeoutMs = resolveTimeout(
    params.connectTimeoutMs,
    CONNECTION_TIMEOUT_MS,
  );
  const idleTimeoutMs = resolveTimeout(params.idleTimeoutMs, IDLE_TIMEOUT_MS);
  const decoder = new HermesSSEDecoder();
  const accumulator = new HermesStreamAccumulator(handlers);
  const {signal} = params;

  if (signal?.aborted) {
    return accumulator.snapshot(true);
  }

  const transport = resolveTransport(params.transport);
  const common = {
    url,
    headers,
    body,
    connectTimeoutMs,
    idleTimeoutMs,
    signal,
    decoder,
    accumulator,
    handlers,
  };

  const interrupted =
    transport === 'fetch'
      ? await streamOverFetch(common)
      : await streamOverXhr(common);

  return accumulator.snapshot(interrupted);
}

interface TransportArgs {
  url: string;
  headers: Record<string, string>;
  body: string;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  signal?: AbortSignal;
  decoder: HermesSSEDecoder;
  accumulator: HermesStreamAccumulator;
  handlers: HermesStreamHandlers;
}

/** fetch + ReadableStream path. Only reachable where the body streams. */
async function streamOverFetch(args: TransportArgs): Promise<boolean> {
  const {url, headers, body, signal, decoder, accumulator, handlers} = args;
  const controller = new AbortController();
  let timedOut = false;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = () => {
    if (idle) {
      clearTimeout(idle);
      idle = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    idle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, args.idleTimeoutMs);
  };
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, {once: true});

  const connectTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, args.connectTimeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error: any) {
      throw fetchFailure(error, timedOut, signal);
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) {
      const text = await safeResponseText(response);
      throw httpError(response.status, text);
    }

    const reader = (response as any).body?.getReader?.();
    if (!reader) {
      // Reachable only when a caller forced `transport: 'fetch'`.
      throw new HermesStreamError(
        'protocol',
        'This runtime cannot stream responses over fetch; use the xhr transport',
      );
    }

    handlers.onOpen?.();

    const TextDecoderCtor: any = (globalThis as any).TextDecoder;
    const textDecoder = new TextDecoderCtor('utf-8');

    try {
      armIdle();
      while (true) {
        const {done, value} = await reader.read();
        if (done) {
          break;
        }
        armIdle();
        const chunk = textDecoder.decode(value, {stream: true});
        if (chunk) {
          for (const frame of decoder.push(chunk)) {
            accumulator.accept(frame);
          }
        }
      }
      const tail = textDecoder.decode();
      if (tail) {
        for (const frame of decoder.push(tail)) {
          accumulator.accept(frame);
        }
      }
    } catch (error: any) {
      // A caller abort keeps the partial answer; a timeout is a real failure.
      if (timedOut) {
        throw new HermesStreamError(
          'timeout',
          'Idle timeout: no data received from the server',
        );
      }
      if (signal?.aborted) {
        return true;
      }
      throw fetchFailure(error, false, signal);
    }

    for (const frame of decoder.flush()) {
      accumulator.accept(frame);
    }
    return false;
  } finally {
    clearIdle();
    clearTimeout(connectTimer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * XHR path: React Native's `fetch` has no body stream, so `onprogress` over
 * the cumulative `responseText` is the transport (same shape as
 * `eventStream.ts`, but keeping the `event:` names).
 */
async function streamOverXhr(args: TransportArgs): Promise<boolean> {
  const {url, headers, body, signal, decoder, accumulator, handlers} = args;

  return new Promise<boolean>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastProcessedLength = 0;
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | null = null;

    const clearIdle = () => {
      if (idle) {
        clearTimeout(idle);
        idle = null;
      }
    };
    const armIdle = () => {
      clearIdle();
      idle = setTimeout(() => {
        finish();
        xhr.abort();
        reject(
          new HermesStreamError(
            'timeout',
            'Idle timeout: no data received from the server',
          ),
        );
      }, args.idleTimeoutMs);
    };
    const onCallerAbort = () => xhr.abort();
    const finish = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      clearIdle();
      clearTimeout(connectTimer);
      signal?.removeEventListener('abort', onCallerAbort);
      return true;
    };

    const connectTimer = setTimeout(() => {
      if (finish()) {
        xhr.abort();
        reject(new HermesStreamError('timeout', 'Connection timed out'));
      }
    }, args.connectTimeoutMs);

    /** Feed only the bytes appended since the previous call. */
    const pump = () => {
      const chunk = xhr.responseText.substring(lastProcessedLength);
      lastProcessedLength = xhr.responseText.length;
      if (!chunk) {
        return;
      }
      for (const frame of decoder.push(chunk)) {
        accumulator.accept(frame);
      }
    };

    xhr.open('POST', url);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    xhr.onreadystatechange = () => {
      if (settled || xhr.readyState !== XMLHttpRequest.HEADERS_RECEIVED) {
        return;
      }
      clearTimeout(connectTimer);
      handlers.onOpen?.();
      armIdle();
    };

    xhr.onprogress = () => {
      if (settled) {
        return;
      }
      armIdle();
      try {
        pump();
      } catch (error) {
        if (finish()) {
          xhr.abort();
          reject(error);
        }
      }
    };

    xhr.onload = () => {
      if (!finish()) {
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(httpError(xhr.status, xhr.responseText));
        return;
      }
      try {
        pump();
        for (const frame of decoder.flush()) {
          accumulator.accept(frame);
        }
      } catch (error) {
        reject(error);
        return;
      }
      resolve(false);
    };

    xhr.onerror = () => {
      if (!finish()) {
        return;
      }
      reject(
        new HermesStreamError(
          'network',
          'Network error: could not reach server',
        ),
      );
    };

    xhr.onabort = () => {
      if (!finish()) {
        return;
      }
      // A caller abort keeps the partial answer; anything else aborted us.
      if (signal?.aborted) {
        resolve(true);
        return;
      }
      reject(abortedError());
    };

    if (signal?.aborted) {
      finish();
      resolve(true);
      return;
    }
    signal?.addEventListener('abort', onCallerAbort, {once: true});
    xhr.send(body);
  });
}

/** Classify a fetch rejection into network / timeout / abort. */
function fetchFailure(
  error: any,
  timedOut: boolean,
  signal: AbortSignal | undefined,
): HermesStreamError {
  if (signal?.aborted) {
    return abortedError();
  }
  if (timedOut) {
    return new HermesStreamError('timeout', 'Connection timed out');
  }
  if (error instanceof HermesStreamError) {
    return error;
  }
  return new HermesStreamError(
    'network',
    'Network error: could not reach server',
  );
}

/** Body text for an error response, bounded and never fatal. */
async function safeResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return typeof text === 'string' ? text.slice(0, 2000) : '';
  } catch {
    return '';
  }
}
