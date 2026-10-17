import React, {useEffect, useState} from 'react';
import {View} from 'react-native';
import {Button, HelperText} from 'react-native-paper';
import {observer} from 'mobx-react';

import {Sheet, TextInput} from '../../components';
import {useTheme} from '../../hooks';
import {hermesStore} from '../../store/HermesStore';

/**
 * Connection settings for the remote Hermes backend.
 *
 * Deliberately minimal: a base URL, the shared API key, and the model name the
 * server is free to ignore. The key is written through to the Keychain by the
 * store; it is never kept in AsyncStorage and never echoed back after saving.
 */
export const HermesSettingsSheet: React.FC<{
  isVisible: boolean;
  onDismiss: () => void;
}> = observer(({isVisible, onDismiss}) => {
  const theme = useTheme();
  const [serverUrl, setServerUrl] = useState(hermesStore.serverUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(hermesStore.model);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // Re-seed the form each time the sheet opens, so an abandoned edit never
  // looks saved.
  useEffect(() => {
    if (isVisible) {
      setServerUrl(hermesStore.serverUrl);
      setModel(hermesStore.model);
      setApiKey('');
      setTestResult(null);
    }
  }, [isVisible]);

  const handleSave = async () => {
    hermesStore.setServerUrl(serverUrl);
    hermesStore.setModel(model);
    if (apiKey.trim()) {
      await hermesStore.setApiKey(apiKey.trim());
    }
    onDismiss();
  };

  const handleTest = async () => {
    // Probe what is typed, not what is saved, so the test is meaningful before
    // the first save.
    hermesStore.setServerUrl(serverUrl);
    if (apiKey.trim()) {
      await hermesStore.setApiKey(apiKey.trim());
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await hermesStore.testConnection();
      setTestResult({
        ok: result.ok,
        text: result.ok
          ? `连接成功 · ${result.modelCount} 个模型`
          : (result.error ?? '连接失败'),
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <Sheet
      isVisible={isVisible}
      onDismiss={onDismiss}
      title="Hermes 远程"
      subtitle="连接到 api_server（/v1/chat/completions）"
      snapPoints={['60%', '90%']}>
      <Sheet.ScrollView>
        <View style={{paddingHorizontal: 2, paddingBottom: 16}}>
          <TextInput
            label="服务器地址"
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="http://192.168.1.10:8642"
            showDivider
          />
          <TextInput
            label="API Key"
            value={apiKey}
            onChangeText={setApiKey}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder={
              hermesStore.hasApiKey ? '已保存（留空则不修改）' : 'sk-…'
            }
            showDivider
          />
          <TextInput
            label="模型名"
            value={model}
            onChangeText={setModel}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="hermes"
          />

          {testResult ? (
            <HelperText
              type={testResult.ok ? 'info' : 'error'}
              visible
              style={{color: testResult.ok ? theme.colors.primary : undefined}}>
              {testResult.text}
            </HelperText>
          ) : null}

          {hermesStore.hasMessages ? (
            <Button
              mode="text"
              onPress={() => hermesStore.clearConversation()}
              style={{alignSelf: 'flex-start', marginTop: 8}}>
              清空对话（{hermesStore.messages.length} 条）
            </Button>
          ) : null}

          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 16,
            }}>
            <Button
              mode="text"
              onPress={handleTest}
              loading={isTesting}
              disabled={isTesting || !serverUrl.trim()}>
              测试连接
            </Button>
            <Button
              mode="contained"
              onPress={handleSave}
              disabled={!serverUrl.trim()}>
              保存
            </Button>
          </View>
        </View>
      </Sheet.ScrollView>
    </Sheet>
  );
});
