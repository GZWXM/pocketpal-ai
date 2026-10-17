import React from 'react';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
    multiGet: jest.fn().mockResolvedValue([]),
    multiSet: jest.fn().mockResolvedValue(undefined),
    getAllKeys: jest.fn().mockResolvedValue([]),
    clear: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn().mockResolvedValue(true),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
}));

import {render} from '../../../../jest/test-utils';
import {hermesStore} from '../../../store/HermesStore';

import {HermesChatScreen} from '../HermesChatScreen';

describe('HermesChatScreen', () => {
  beforeEach(() => {
    hermesStore.clearConversation();
    hermesStore.setServerUrl('');
  });

  it('renders the empty state with a pointer to settings', () => {
    const {getByText} = render(<HermesChatScreen />, {
      withNavigation: true,
      withSafeArea: true,
      withBottomSheetProvider: true,
    });

    expect(getByText('Hermes 远程对话')).toBeTruthy();
    expect(getByText('打开设置')).toBeTruthy();
  });

  it('renders the composer even before a server is configured', () => {
    const {getByPlaceholderText} = render(<HermesChatScreen />, {
      withNavigation: true,
      withSafeArea: true,
      withBottomSheetProvider: true,
    });

    expect(getByPlaceholderText('先配置服务器地址')).toBeTruthy();
  });
});
