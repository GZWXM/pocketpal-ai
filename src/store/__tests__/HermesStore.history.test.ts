/**
 * `loadHistory` contract: the device timeline is the source of truth, so the
 * mapping from raw entries (float-second `ts`, `kind: 'tool'` rows, numeric
 * `message_id`) to local rows is pinned here against a real payload shape.
 */
import {HermesStore} from '../HermesStore';

jest.mock('react-native-keychain', () => ({
  getGenericPassword: jest.fn(async () => ({password: 'test-key'})),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock('react-native-get-random-values', () => ({}));

const TIMELINE = {
  object: 'hermes.device.timeline',
  session_id: '20261018_081219_0b7a67c4',
  count: 5,
  has_more: true,
  entries: [
    {
      session_id: '20261018_081219_0b7a67c4',
      kind: 'chat',
      role: 'user',
      content: '在吗',
      tool_name: null,
      ts: 1792302000.5,
      message_id: 1,
    },
    {
      session_id: '20261018_081219_0b7a67c4',
      kind: 'tool',
      role: 'tool',
      content: 'execute_code · 输出 1 行 / 20 字符',
      tool_name: 'execute_code',
      ts: 1792302001.25,
      message_id: 2,
    },
    {
      session_id: '20261018_081219_0b7a67c4',
      kind: 'chat',
      role: 'assistant',
      content: '在的',
      tool_name: null,
      ts: 1792302002.75,
      message_id: 3,
    },
    {
      session_id: 'cron_session',
      kind: 'cron',
      role: 'assistant',
      job: 'morning-brief',
      content: '早上好，今日简报',
      tool_name: null,
      ts: 1792302100,
      message_id: 4,
    },
    {
      session_id: '20261018_081219_0b7a67c4',
      kind: 'chat',
      role: 'assistant',
      content: '   ',
      tool_name: null,
      ts: 1792302200,
      message_id: 5,
    },
  ],
};

const fetchMock = jest.fn(async (url: string) => {
  if (url.includes('/timeline')) {
    return {
      ok: true,
      json: async () => TIMELINE,
    } as unknown as Response;
  }
  if (url.includes('/session')) {
    return {
      ok: true,
      json: async () => ({session_id: '20261018_081219_0b7a67c4'}),
    } as unknown as Response;
  }
  throw new Error(`unexpected url ${url}`);
});

describe('HermesStore.loadHistory', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    (global as any).fetch = fetchMock;
  });

  it('maps timeline entries to chat rows', async () => {
    const store = new HermesStore();
    store.serverUrl = 'http://example.test:18642';
    await store.loadHistory();

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://example.test:18642/api/devices/watch-magic7/timeline?limit=200',
    );
    // Empty assistant row skipped; tool row folded into the answer.
    expect(store.messages).toHaveLength(3);
    expect(store.messages[0]).toMatchObject({type: 'text', text: '在吗'});
    expect(store.messages[0].createdAt).toBe(1792302000500);
    expect(store.messages[1]).toMatchObject({
      type: 'assistant_turn',
      id: 'srv-3',
    });
    const turn = store.messages[1] as any;
    expect(turn.steps[0].content).toBe('在的');
    expect(turn.steps[0].toolCalls).toHaveLength(1);
    expect(turn.steps[0].toolCalls[0].function.name).toBe('execute_code');
    // Cron pushes from another session still show up, in time order.
    const cronRow = store.messages[2] as any;
    expect(cronRow.type).toBe('assistant_turn');
    expect(cronRow.steps[0].content).toBe('早上好，今日简报');
    // The bound session id is adopted for subsequent sends.
    expect(store.sessionId).toBe('20261018_081219_0b7a67c4');
  });

  it('does not duplicate rows the server has already stored', async () => {
    const store = new HermesStore();
    store.serverUrl = 'http://example.test:18642';
    await store.loadHistory();
    // Locally echoed rows that the transcript above also contains.
    (store as any).rememberOptimistic('user', '在吗');
    (store as any).rememberOptimistic('assistant', '在的');
    await store.loadHistory();
    expect(store.messages).toHaveLength(3);
    expect(
      store.messages.filter(m => m.type === 'text' && m.text === '在吗'),
    ).toHaveLength(1);
  });

  it('keeps an unconfirmed local row at the tail', async () => {
    const store = new HermesStore();
    store.serverUrl = 'http://example.test:18642';
    await store.loadHistory();
    (store as any).rememberOptimistic('user', '刚发的还没入库');
    await store.loadHistory();
    expect(store.messages).toHaveLength(4);
    expect(store.messages[3]).toMatchObject({
      type: 'text',
      text: '刚发的还没入库',
    });
  });

  it('clears the cached session when the id rotates', async () => {
    const store = new HermesStore();
    store.serverUrl = 'http://example.test:18642';
    store.sessionId = 'stale-id';
    await store.resolveSessionId();
    expect(store.sessionId).toBe('20261018_081219_0b7a67c4');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({session_id: 'rotated-id'}),
    } as unknown as Response);
    expect(await store.resolveSessionId(true)).toBe('rotated-id');
  });
});
