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

  constructor() {
    makeAutoObservable<HermesStore, 'abortController' | 'runSeq'>(this, {
      abortController: false,
      runSeq: false,
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
    await this.runNewTurn();
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
   * Pull the server-side transcript for this session and rebuild the local
   * rows. The server is the source of truth (it also holds turns sent from
   * other channels), so the local list is replaced rather than merged —
   * otherwise a failed send leaves a ghost row that never existed remotely.
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
    const url =
      `${normalizeUrl(base)}/api/sessions/${encodeURIComponent(this.sessionId)}` +
      `/messages?limit=${limit}&order=latest`;
    try {
      const res = await fetch(url, {
        headers: apiKey ? {Authorization: `Bearer ${apiKey}`} : undefined,
      });
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as {data?: unknown};
      const rows = Array.isArray(json?.data) ? json.data : [];
      const toMs = (row: Record<string, unknown>): number => {
        const v = row.timestamp ?? row.created_at;
        if (typeof v === 'number') {
          return v < 1e12 ? v * 1000 : v;
        }
        const parsed = typeof v === 'string' ? Date.parse(v) : NaN;
        return Number.isFinite(parsed) ? parsed : Date.now();
      };
      const next: HermesMessage[] = [];
      for (const raw of rows) {
        const row = raw as Record<string, unknown>;
        const content =
          typeof row.content === 'string' ? row.content.trim() : '';
        if (!content) {
          continue;
        }
        const id = typeof row.id === 'string' ? row.id : uuidv4();
        if (row.role === 'user') {
          next.push({
            id,
            author: user,
            createdAt: toMs(row),
            type: 'text',
            text: content,
          });
        } else if (row.role === 'assistant') {
          next.push({
            id,
            author: assistant,
            createdAt: toMs(row),
            type: 'assistant_turn',
            steps: [{content}],
          });
        }
      }
      if (next.length) {
        runInAction(() => {
          this.messages = next;
        });
      }
    } catch {
      // Offline or server down: keep whatever is already on screen.
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

    try {
      const result: HermesStreamResult = await streamHermesChat(
        {
          serverUrl: this.serverUrl,
          apiKey,
          model: this.model,
          messages: this.toWireMessages().filter(m => m.content.trim()),
          sessionId: this.sessionId,
          signal: controller.signal,
        },
        {
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
          onContent: delta => {
            pendingContent += delta;
            scheduleFlush();
          },
          onReasoning: delta => {
            pendingReasoning += delta;
            scheduleFlush();
          },
          onToolProgress: applyToolProgress,
        },
      );

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
