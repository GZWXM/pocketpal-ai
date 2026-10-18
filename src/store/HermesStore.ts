import 'react-native-get-random-values';
import {makeAutoObservable, runInAction} from 'mobx';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {makePersistable} from 'mobx-persist-store';
import * as Keychain from 'react-native-keychain';
import {v4 as uuidv4} from 'uuid';

import {
  HermesStreamError,
  streamHermesChat,
  type HermesErrorKind,
  type HermesStreamResult,
  type HermesToolProgress,
  type HermesWireMessage,
} from '../api/hermes';
import {normalizeUrl} from '../api/http';
import {fetchModels} from '../api/openai';
import {assistant, user} from '../utils/chat';
import type {AgentStep, AgentToolCall, MessageType} from '../utils/types';

/**
 * Hermes remote backend store.
 *
 * One conversation, one stream: the server keeps no session of its own, so
 * every message lives in a single flat array here and the whole history is
 * resent as the `messages` payload on each turn.
 *
 * Message shape is deliberately the app's own: a user row is a
 * `MessageType.Text`, an answer is a `MessageType.AssistantTurn` whose
 * `steps[]` carry `reasoningContent` / `content` / `toolCalls`. Renderers
 * that already understand assistant turns consume these rows unchanged.
 */

/** Keychain service prefix. Keyed by server so a key never follows a URL change. */
const KEYCHAIN_SERVICE_PREFIX = 'pocketpal-hermes-';

/** Coalesce per-token writes into batched UI flushes (~20 Hz). */
const STREAMING_THROTTLE_MS = 50;

const DEFAULT_MODEL = 'hermes';

/** Stream lifecycle as the UI sees it. */
export type HermesStatus = 'idle' | 'connecting' | 'streaming' | 'error';

/**
 * `AgentToolCall` plus the progress the Hermes server reports for a call it
 * runs itself. Assignable to `AgentToolCall` (the inherited fields are the
 * complete wire shape), so a step carrying these still satisfies
 * `AgentStep.toolCalls`.
 */
export interface HermesToolCall extends AgentToolCall {
  /** UI-only progress. Never serialized to the wire. */
  progress?: {
    emoji?: string;
    label?: string;
    /** Server-reported status, e.g. `running` / `done` / `error`. */
    status: string;
  };
}

/** A step whose tool calls also carry progress. */
export interface HermesStep extends AgentStep {
  toolCalls?: HermesToolCall[];
}

/** An assistant turn carrying Hermes steps. */
export interface HermesAssistantTurn extends MessageType.AssistantTurn {
  steps: HermesStep[];
}

/** The only two row types this backend produces. */
export type HermesMessage = MessageType.Text | HermesAssistantTurn;

/** Last connection probe outcome, for the settings surface. */
export type HermesConnectionState = 'unknown' | 'ok' | 'error';

/** `pocketpal-hermes-<normalized url>`, or `...-unset` before a URL is set. */
function keychainService(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  return `${KEYCHAIN_SERVICE_PREFIX}${trimmed ? normalizeUrl(trimmed) : 'unset'}`;
}

/** Visible text of an assistant turn, per the `assistant*` row convention. */
function turnText(turn: HermesAssistantTurn): string {
  return turn.steps
    .map(step => step.content ?? '')
    .filter(Boolean)
    .join('\n\n');
}

/** A row this app rendered before the server confirmed it. */
interface OptimisticRow {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

/**
 * Identity used to match a local row against the server's copy of it. The
 * server assigns its own `message_id`, so ids cannot be compared; content is
 * the only common key. Whitespace is collapsed so a reflowed answer still
 * matches.
 */
function rowKey(role: 'user' | 'assistant', text: string): string {
  return `${role}\u0000${text.replace(/\s+/g, ' ').trim()}`;
}

/** A failure that means "this session id is gone, resolve again". */
function isStaleSession(error: unknown): boolean {
  return (
    error instanceof HermesStreamError &&
    (error.status === 404 || error.status === 409 || error.status === 410)
  );
}

export class HermesStore {
  /** Base URL of the remote Hermes api_server. */
  serverUrl = '';
  /** Model name sent in the completion body; the server may ignore it. */
  model = DEFAULT_MODEL;
  /** Flat history: user `Text` rows and `AssistantTurn` rows, in order. */
  messages: HermesMessage[] = [];
  /**
   * Stable session id, sent as `X-Hermes-Session-Id`. The server appends every
   * turn to this session, which is what lets `loadHistory()` pull the whole
   * conversation back after a restart.
   */
  sessionId: string = `pocketpal-${uuidv4()}`;
  /**
   * Device address used for the server's `/api/devices/*` endpoints. The
   * server binds this id to the QQ DM session (`_DEVICE_ROUTE_BINDINGS`), so
   * the app reads and writes the very same transcript the QQ bot uses.
   */
  deviceId = 'watch-magic7';
  status: HermesStatus = 'idle';
  /** Human-readable last failure, cleared on the next send. */
  error: string | null = null;
  /** Machine-readable classification of `error`. */
  errorKind: HermesErrorKind | null = null;
  connection: HermesConnectionState = 'unknown';
  /** True once a key is present in the Keychain for the current server. */
  hasApiKey = false;
  lastConnectedAt: number | null = null;

  private abortController: AbortController | null = null;
  /** Counts runs so a late result from an abandoned stream writes nothing. */
  private runSeq = 0;
  /** Session id the device binding resolved to; `null` until first success. */
  private resolvedSessionId: string | null = null;
  /** In-flight `/session` lookup, shared by concurrent callers. */
  private sessionResolveInFlight: Promise<string | null> | null = null;
  /**
   * Rows this app added locally that the server has not echoed back yet.
   * `loadHistory()` consumes them: an entry found in the server transcript is
   * acknowledged and dropped, so the same message never renders twice.
   */
  private optimistic: OptimisticRow[] = [];

  constructor() {
    makeAutoObservable<
      HermesStore,
      | 'abortController'
      | 'runSeq'
      | 'resolvedSessionId'
      | 'sessionResolveInFlight'
      | 'optimistic'
    >(this, {
      abortController: false,
      runSeq: false,
      resolvedSessionId: false,
      sessionResolveInFlight: false,
      optimistic: false,
    });

    // The API key never lands in AsyncStorage; only URL, model and history.
    makePersistable(this, {
      name: 'HermesStore',
      properties: ['serverUrl', 'model', 'messages', 'sessionId'],
      storage: AsyncStorage,
    }).then(() => this.refreshApiKeyPresence());

    void this.refreshApiKeyPresence();
  }

  get isBusy(): boolean {
    return this.status === 'connecting' || this.status === 'streaming';
  }

  /** A send is possible: a server is configured and no stream is running. */
  get canSend(): boolean {
    return !!this.serverUrl.trim() && !this.isBusy;
  }

  get hasMessages(): boolean {
    return this.messages.length > 0;
  }

  // --- configuration -------------------------------------------------------

  /**
   * Changing the host invalidates the stored key: it was saved under the old
   * server's service name and must not silently ride along.
   */
  setServerUrl(url: string): void {
    const next = url.trim();
    if (next === this.serverUrl) {
      return;
    }
    this.serverUrl = next;
    this.connection = 'unknown';
    this.lastConnectedAt = null;
    void this.refreshApiKeyPresence();
  }

  setModel(model: string): void {
    this.model = model.trim() || DEFAULT_MODEL;
  }

  // --- API key (Keychain) --------------------------------------------------

  async setApiKey(apiKey: string): Promise<void> {
    const value = apiKey.trim();
    try {
      await Keychain.setGenericPassword('apiKey', value, {
        service: keychainService(this.serverUrl),
      });
      this.hasApiKey = !!value;
    } catch (error) {
      console.error('Failed to save Hermes API key:', error);
    }
  }

  async getApiKey(): Promise<string | undefined> {
    try {
      const credentials = await Keychain.getGenericPassword({
        service: keychainService(this.serverUrl),
      });
      return credentials ? credentials.password : undefined;
    } catch (error) {
      console.error('Failed to load Hermes API key:', error);
      return undefined;
    }
  }

  async clearApiKey(): Promise<void> {
    try {
      await Keychain.resetGenericPassword({
        service: keychainService(this.serverUrl),
      });
    } catch (error) {
      console.error('Failed to remove Hermes API key:', error);
    } finally {
      this.hasApiKey = false;
    }
  }

  /** Re-reads the Keychain so a restored URL shows the right key state. */
  async refreshApiKeyPresence(): Promise<void> {
    const key = await this.getApiKey();
    this.hasApiKey = !!key;
  }

  /**
   * Probe the server with a `/v1/models` read — the cheapest authenticated
   * call that also proves the base URL is right. Reuses the OpenAI helper so
   * URL normalization and status handling stay in one place.
   */
  async testConnection(): Promise<{
    ok: boolean;
    modelCount: number;
    error?: string;
  }> {
    if (!this.serverUrl.trim()) {
      this.connection = 'error';
      this.error = 'Server URL is not configured';
      this.errorKind = 'protocol';
      return {ok: false, modelCount: 0, error: 'Server URL is not configured'};
    }
    try {
      const apiKey = await this.getApiKey();
      const models = await fetchModels(this.serverUrl, apiKey);
      runInAction(() => {
        this.connection = 'ok';
        this.lastConnectedAt = Date.now();
        this.error = null;
        this.errorKind = null;
      });
      return {ok: true, modelCount: models.length};
    } catch (error: any) {
      const failure = toStreamError(error);
      runInAction(() => {
        this.connection = 'error';
        this.error = failure.message;
        this.errorKind = failure.kind;
      });
      return {ok: false, modelCount: 0, error: failure.message};
    }
  }

  // --- conversation --------------------------------------------------------

  /** Append the user row, open an assistant turn, and stream the answer. */
  async send(input: string): Promise<void> {
    const text = input.trim();
    if (!text || this.isBusy) {
      return;
    }
    if (!this.serverUrl.trim()) {
      this.fail(
        new HermesStreamError('protocol', 'Server URL is not configured'),
      );
      return;
    }

    this.messages.push({
      id: uuidv4(),
      author: user,
      createdAt: Date.now(),
      type: 'text',
      text,
    });
    this.rememberOptimistic('user', text);
    await this.runNewTurn();
  }

  /** Track a locally rendered row until `loadHistory()` sees the server's copy. */
  private rememberOptimistic(role: 'user' | 'assistant', text: string): void {
    if (!text.trim()) {
      return;
    }
    this.optimistic.push({role, text, createdAt: Date.now()});
    // Only the newest handful can still be unconfirmed; older ones matter
    // solely if a reload happens right after a burst of sends.
    if (this.optimistic.length > 20) {
      this.optimistic.splice(0, this.optimistic.length - 20);
    }
  }

  /**
   * Re-send the last exchange: drops the trailing assistant turn (a partial
   * or failed one) and streams it again from the retained user row.
   */
  async retry(): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const last = this.messages[this.messages.length - 1];
    if (last && last.type === 'assistant_turn') {
      this.messages.pop();
    }
    if (!this.messages.some(m => m.type === 'text')) {
      return;
    }
    await this.runNewTurn();
  }

  /** Abort the in-flight stream. Partial text is kept and marked final. */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.isBusy) {
      this.status = 'idle';
    }
  }

  clearConversation(): void {
    this.stop();
    this.runSeq++; // orphan any in-flight run
    this.messages = [];
    this.error = null;
    this.errorKind = null;
    this.status = 'idle';
  }

  /**
   * Pull the server-side transcript for this device and rebuild the local
   * rows. `GET /api/devices/{id}/timeline` is the merged chain: the bound
   * session (QQ DM) plus cron pushes, ascending by time, with each entry
   * carrying `ts` in float seconds, `role`, `kind` (`chat` / `tool`), `content`
   * and `message_id`.
   *
   * The server is the source of truth, so the local list is replaced rather
   * than merged — but rows this app pushed and the server has not echoed yet
   * are carried over (see `optimistic`), which is what keeps a send → reload
   * cycle from showing every message twice.
   */
  async loadHistory(limit = 200): Promise<void> {
    const base = this.serverUrl.trim();
    if (!base) {
      return;
    }
    let apiKey: string | undefined;
    try {
      apiKey = await this.getApiKey();
    } catch {
      apiKey = undefined;
    }
    // Device timeline = the QQ session chain + cron pushes, merged by time.
    const url =
      `${normalizeUrl(base)}/api/devices/${encodeURIComponent(this.deviceId)}` +
      `/timeline?limit=${limit}`;
    try {
      const res = await fetch(url, {
        headers: apiKey ? {Authorization: `Bearer ${apiKey}`} : undefined,
      });
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as {
        entries?: unknown;
        session_id?: unknown;
      };
      // The binding already tells us the session; remember it so the next
      // send joins this transcript without another round trip.
      if (typeof json?.session_id === 'string' && json.session_id) {
        const id = json.session_id;
        runInAction(() => {
          this.resolvedSessionId = id;
          this.sessionId = id;
        });
      }
      const rows = Array.isArray(json?.entries) ? json.entries : [];
      /** Seconds (float) → milliseconds; already-ms values pass through. */
      const toMs = (row: Record<string, unknown>): number => {
        const v = row.ts ?? row.timestamp ?? row.created_at;
        if (typeof v === 'number') {
          return v < 1e12 ? v * 1000 : v;
        }
        const parsed = typeof v === 'string' ? Date.parse(v) : NaN;
        return Number.isFinite(parsed) ? parsed : Date.now();
      };

      const next: HermesMessage[] = [];
      // Tool rows are folded into the answer they belong to instead of
      // becoming chat bubbles of their own: one answer can produce dozens.
      // The server emits them on either side of that answer, so they buffer
      // until the next assistant row claims them.
      let pendingTools: HermesToolCall[] = [];
      for (const raw of rows) {
        const row = raw as Record<string, unknown>;
        const content =
          typeof row.content === 'string' ? row.content.trim() : '';
        if (!content) {
          continue;
        }
        const createdAt = toMs(row);
        const mid = row.message_id;
        const id =
          typeof mid === 'number' || (typeof mid === 'string' && mid)
            ? `srv-${mid}`
            : `srv-${createdAt}-${next.length}`;

        if (row.kind === 'tool' || row.role === 'tool') {
          pendingTools.push({
            id,
            type: 'function',
            function: {name: String(row.tool_name ?? 'tool'), arguments: ''},
            progress: {status: 'done', label: content},
          });
          continue;
        }

        if (row.role === 'user') {
          // A tool run that never produced visible text has no bubble to
          // attach to; drop it rather than leak it below the next question.
          pendingTools = [];
          next.push({id, author: user, createdAt, type: 'text', text: content});
          continue;
        }
        if (row.role === 'assistant') {
          const turn: HermesAssistantTurn = {
            id,
            author: assistant,
            createdAt,
            type: 'assistant_turn',
            steps: [
              pendingTools.length
                ? {content, toolCalls: pendingTools}
                : {content},
            ],
          };
          pendingTools = [];
          next.push(turn);
        }
        // Anything else (system rows, unknown kinds) is not chattable.
      }

      // Acknowledge local rows the server now owns; keep the rest on screen.
      const counts = new Map<string, number>();
      for (const message of next) {
        const key =
          message.type === 'text'
            ? rowKey('user', message.text)
            : rowKey('assistant', turnText(message));
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const pending: OptimisticRow[] = [];
      for (const row of this.optimistic) {
        const key = rowKey(row.role, row.text);
        const seen = counts.get(key) ?? 0;
        if (seen > 0) {
          counts.set(key, seen - 1);
          continue;
        }
        pending.push(row);
      }
      pending.forEach((row, index) => {
        const id = `local-${row.createdAt}-${index}`;
        if (row.role === 'user') {
          next.push({
            id,
            author: user,
            createdAt: row.createdAt,
            type: 'text',
            text: row.text,
          });
          return;
        }
        next.push({
          id,
          author: assistant,
          createdAt: row.createdAt,
          type: 'assistant_turn',
          steps: [{content: row.text}],
        });
      });

      runInAction(() => {
        // A live stream owns the tail of the list; replacing it mid-flight
        // would orphan the row being written into.
        if (this.isBusy) {
          return;
        }
        this.optimistic = pending;
        this.messages = next;
      });
    } catch {
      // Offline or server down: keep whatever is already on screen.
    }
  }

  /**
   * Resolve the session the device id is bound to (`/api/devices/{id}/session`).
   * Cached: the binding only changes when the server rotates the transcript.
   * Returns `null` when the lookup fails, leaving the caller on its last
   * known id.
   */
  async resolveSessionId(force = false): Promise<string | null> {
    if (!force && this.resolvedSessionId) {
      return this.resolvedSessionId;
    }
    if (this.sessionResolveInFlight) {
      return this.sessionResolveInFlight;
    }
    const base = this.serverUrl.trim();
    if (!base) {
      return null;
    }
    const task = (async (): Promise<string | null> => {
      let apiKey: string | undefined;
      try {
        apiKey = await this.getApiKey();
      } catch {
        apiKey = undefined;
      }
      const url =
        `${normalizeUrl(base)}/api/devices/${encodeURIComponent(this.deviceId)}` +
        `/session`;
      try {
        const res = await fetch(url, {
          headers: apiKey ? {Authorization: `Bearer ${apiKey}`} : undefined,
        });
        if (!res.ok) {
          return null;
        }
        const json = (await res.json()) as {session_id?: unknown};
        const id =
          typeof json?.session_id === 'string' ? json.session_id.trim() : '';
        if (!id) {
          return null;
        }
        runInAction(() => {
          this.resolvedSessionId = id;
          this.sessionId = id;
        });
        return id;
      } catch {
        return null;
      }
    })();
    this.sessionResolveInFlight = task;
    try {
      return await task;
    } finally {
      this.sessionResolveInFlight = null;
    }
  }

  /** Forget everything but the key: URL, model and history. */
  async reset(): Promise<void> {
    this.clearConversation();
    this.connection = 'unknown';
    this.lastConnectedAt = null;
    this.serverUrl = '';
    this.model = DEFAULT_MODEL;
  }

  // --- streaming -----------------------------------------------------------

  private async runNewTurn(): Promise<void> {
    const turn: HermesAssistantTurn = {
      id: uuidv4(),
      author: assistant,
      createdAt: Date.now(),
      type: 'assistant_turn',
      steps: [{content: '', partial: true}],
    };
    this.messages.push(turn);
    // MobX deep-converts an object pushed into an observable array, so the
    // row the UI reads is not the object we just built — stream into the
    // stored one or every delta lands on an orphan.
    const live = this.messages[this.messages.length - 1] as HermesAssistantTurn;
    await this.run(live);
  }

  /**
   * Drive one stream into `turn.steps[0]`. Writes are throttled so a fast
   * token stream does not re-render the list per delta; `runSeq` makes a
   * run that a newer one replaced a no-op.
   */
  private async run(turn: HermesAssistantTurn): Promise<void> {
    const seq = ++this.runSeq;
    const controller = new AbortController();
    this.abortController = controller;
    this.status = 'connecting';
    this.error = null;
    this.errorKind = null;

    const step = turn.steps[0];
    let pendingContent = '';
    let pendingReasoning = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (seq !== this.runSeq) {
        return;
      }
      // `enforceActions: 'observed'` is MobX's default here: a write to an
      // observed step must happen inside an action.
      runInAction(() => {
        if (pendingContent) {
          step.content = (step.content ?? '') + pendingContent;
          pendingContent = '';
        }
        if (pendingReasoning) {
          step.reasoningContent =
            (step.reasoningContent ?? '') + pendingReasoning;
          pendingReasoning = '';
        }
      });
    };
    const scheduleFlush = () => {
      if (flushTimer) {
        return;
      }
      flushTimer = setTimeout(flush, STREAMING_THROTTLE_MS);
    };

    /** One tool call entry per server-reported call, updated in place. */
    const applyToolProgress = (progress: HermesToolProgress) => {
      if (seq !== this.runSeq) {
        return;
      }
      const calls: HermesToolCall[] = step.toolCalls ? [...step.toolCalls] : [];
      const key = progress.toolCallId ?? progress.tool;
      let index = calls.findIndex(
        call => (progress.toolCallId ? call.id : call.function.name) === key,
      );
      if (index === -1) {
        calls.push({
          id: progress.toolCallId ?? `hermes-tool-${calls.length}`,
          type: 'function',
          // The server runs the call; the app never sees its arguments.
          function: {name: progress.tool, arguments: ''},
          progress: {
            status: progress.status,
            emoji: progress.emoji,
            label: progress.label,
          },
        });
        index = calls.length - 1;
      } else {
        calls[index] = {
          ...calls[index],
          progress: {
            status: progress.status,
            emoji: progress.emoji ?? calls[index].progress?.emoji,
            label: progress.label ?? calls[index].progress?.label,
          },
        };
      }
      runInAction(() => {
        step.toolCalls = calls;
      });
    };

    let apiKey: string | undefined;
    try {
      apiKey = await this.getApiKey();
    } catch {
      apiKey = undefined;
    }

    // Join the transcript the device id is bound to (the QQ DM session), not
    // a fresh private one: only that id makes the turn show up for the bot
    // and in the timeline this screen loads. Falls back to the persisted id
    // when the lookup fails, so a flaky /session never blocks a send.
    const resolved = await this.resolveSessionId().catch(() => null);
    let sessionId = resolved ?? this.sessionId;
    const requestBody = {
      serverUrl: this.serverUrl,
      apiKey,
      model: this.model,
      messages: this.toWireMessages().filter(m => m.content.trim()),
      signal: controller.signal,
    };

    const streamHandlers = {
      onOpen: () => {
        if (seq !== this.runSeq) {
          return;
        }
        runInAction(() => {
          this.status = 'streaming';
          this.connection = 'ok';
          this.lastConnectedAt = Date.now();
        });
      },
      onContent: (delta: string) => {
        pendingContent += delta;
        scheduleFlush();
      },
      onReasoning: (delta: string) => {
        pendingReasoning += delta;
        scheduleFlush();
      },
      onToolProgress: applyToolProgress,
    };

    try {
      let result: HermesStreamResult;
      try {
        result = await streamHermesChat(
          {...requestBody, sessionId},
          streamHandlers,
        );
      } catch (error) {
        // The server rotates transcripts (`/new`); a stale id comes back as
        // 404/409. Re-resolve once and replay against the current session.
        if (!isStaleSession(error) || controller.signal.aborted) {
          throw error;
        }
        const fresh = await this.resolveSessionId(true).catch(() => null);
        if (!fresh || fresh === sessionId) {
          throw error;
        }
        sessionId = fresh;
        result = await streamHermesChat(
          {...requestBody, sessionId},
          streamHandlers,
        );
      }

      flush();
      runInAction(() => {
        if (seq !== this.runSeq) {
          return;
        }
        // Reconcile with the transport's own accumulator: a delta that a
        // handler missed must not be lost from the persisted row.
        if (!step.content && result.content) {
          step.content = result.content;
        }
        if (!step.reasoningContent && result.reasoning) {
          step.reasoningContent = result.reasoning;
        }
        step.partial = false;
        this.status = 'idle';
        if (result.interrupted) {
          // Deliberate stop: the partial answer stays, nothing is "wrong".
          this.error = null;
          this.errorKind = null;
        }
      });
      // The server persists this answer; remember it so a reload that races
      // ahead of the write does not render a second copy.
      if (seq === this.runSeq && step.content) {
        this.rememberOptimistic('assistant', step.content);
      }
    } catch (error: any) {
      flush();
      runInAction(() => {
        if (seq !== this.runSeq) {
          return;
        }
        step.partial = false;
        this.status = 'error';
      });
      this.fail(toStreamError(error));
    } finally {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  private fail(error: HermesStreamError): void {
    this.error = error.message;
    this.errorKind = error.kind;
    if (error.kind === 'auth' || error.kind === 'network') {
      this.connection = 'error';
    }
  }

  /**
   * Flatten the history to the wire. A turn contributes the join of its
   * steps' visible content; reasoning and tool progress stay local — the
   * server owns the tool loop and does not want its own narration back.
   */
  toWireMessages(): HermesWireMessage[] {
    const wire: HermesWireMessage[] = [];
    for (const message of this.messages) {
      if (message.type === 'text') {
        wire.push({role: 'user', content: message.text});
        continue;
      }
      if (message.type === 'assistant_turn') {
        const content = turnText(message);
        if (content) {
          wire.push({role: 'assistant', content});
        }
      }
    }
    return wire;
  }
}

/** Classify anything thrown into the store's error vocabulary. */
function toStreamError(error: any): HermesStreamError {
  if (error instanceof HermesStreamError) {
    return error;
  }
  const message: string =
    typeof error?.message === 'string' && error.message
      ? error.message
      : 'Unexpected error';
  return new HermesStreamError('network', message);
}

export const hermesStore = new HermesStore();
export default hermesStore;
