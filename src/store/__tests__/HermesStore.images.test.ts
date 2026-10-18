/**
 * Image attachments on the Hermes wire. The row keeps the device URI so the
 * bubble can render it; only `toWireMessages` expands it into OpenAI-style
 * content parts (the api layer then inlines the file as base64).
 */
import {runInAction} from 'mobx';

import {HermesStore} from '../HermesStore';
import {user} from '../../utils/chat';

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

const imageRow = (text: string, imageUris: string[]) => ({
  id: 'row-1',
  author: user,
  createdAt: 1,
  type: 'text' as const,
  text,
  imageUris,
});

describe('HermesStore image attachments', () => {
  it('expands a user row with images into text + image_url parts', () => {
    const store = new HermesStore();
    runInAction(() => {
      store.messages.push(imageRow('看看这张图', ['file:///tmp/a.jpg']));
    });

    expect(store.toWireMessages()).toEqual([
      {
        role: 'user',
        content: [
          {type: 'text', text: '看看这张图'},
          {type: 'image_url', image_url: {url: 'file:///tmp/a.jpg'}},
        ],
      },
    ]);
  });

  it('omits the text part for an uncaptioned image', () => {
    const store = new HermesStore();
    runInAction(() => {
      store.messages.push(imageRow('', ['file:///tmp/a.jpg']));
    });

    expect(store.toWireMessages()).toEqual([
      {
        role: 'user',
        content: [{type: 'image_url', image_url: {url: 'file:///tmp/a.jpg'}}],
      },
    ]);
  });

  it('keeps text-only rows as plain strings', () => {
    const store = new HermesStore();
    runInAction(() => {
      store.messages.push({
        id: 'row-2',
        author: user,
        createdAt: 1,
        type: 'text',
        text: '纯文本',
      });
    });

    expect(store.toWireMessages()).toEqual([{role: 'user', content: '纯文本'}]);
  });
});
