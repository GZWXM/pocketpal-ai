import React, {useCallback, useState} from 'react';
import {
  FlatList,
  ImageBackground,
  ListRenderItemInfo,
  Platform,
  StatusBar,
  View,
} from 'react-native';
import {observer} from 'mobx-react';
import {Button, IconButton, Text} from 'react-native-paper';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {ChatScaffold} from '../../components/ChatScaffold';
import {
  Bubble,
  ChatInput,
  Message,
  PendingIndicator,
  HeaderLeft,
} from '../../components';
import {useComponentSize} from '../../components/KeyboardAccessoryView/hooks';
import {useTheme} from '../../hooks';
import {UserContext, calculateChatMessages} from '../../utils';
import {user} from '../../utils/chat';
import {MessageType} from '../../utils/types';
import {hermesStore} from '../../store/HermesStore';

import {HermesSettingsSheet} from './HermesSettingsSheet';

const renderBubble = ({
  child,
  message,
  nextMessageInGroup,
  scale,
}: {
  child: React.ReactNode;
  message: MessageType.Any;
  nextMessageInGroup: boolean;
  scale?: any;
}) => (
  <Bubble
    child={child}
    message={message}
    nextMessageInGroup={nextMessageInGroup}
    scale={scale}
  />
);

/**
 * Remote chat surface.
 *
 * Same skeleton as the local `ChatView` — `ChatScaffold` owns the keyboard
 * avoidance, the sticky input bar and the inverted list header — but the
 * message source is `hermesStore`, which talks to a remote `api_server` over
 * `/v1/chat/completions` and streams reasoning + tool progress as named SSE
 * events. Nothing here touches the local llama context.
 */
export const HermesChatScreen: React.FC = observer(() => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [settingsVisible, setSettingsVisible] = useState(false);
  const {onLayout: onInputLayout, size: inputSize} = useComponentSize();
  const {onLayout: onRootLayout, size: rootSize} = useComponentSize();

  const configured = !!hermesStore.serverUrl.trim();

  const {chatMessages} = calculateChatMessages(
    hermesStore.messages as MessageType.Any[],
    user,
    {showUserNames: false, showDateHeaders: true},
  );

  const handleSendPress = useCallback((message: MessageType.PartialText) => {
    void hermesStore.send(message.text);
  }, []);

  const renderMessage = useCallback(
    ({item}: ListRenderItemInfo<MessageType.DerivedAny>) => {
      const roundBorder = item.type !== 'dateHeader' && item.nextMessageInGroup;
      const showAvatar = item.type !== 'dateHeader' && !item.nextMessageInGroup;

      return (
        <View>
          <Message
            enableAnimation={false}
            message={item}
            messageWidth={Math.floor(Math.min(rootSize.width * 0.92, 900))}
            roundBorder={roundBorder}
            showAvatar={showAvatar}
            showName={false}
            showStatus={false}
            showUserAvatars={false}
            usePreviewData={false}
            renderBubble={renderBubble}
          />
        </View>
      );
    },
    [rootSize.width],
  );

  const header = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 4,
        // 顶栏避开状态栏（信号/电量那一行）
        paddingTop: insets.top + 6,
        paddingBottom: 6,
      }}>
      <HeaderLeft />
      <Text variant="titleMedium" style={{flex: 1}} numberOfLines={1}>
        Hermes（远程）
      </Text>
      {hermesStore.hasMessages ? (
        <IconButton
          icon="delete-outline"
          size={20}
          onPress={() => hermesStore.clearConversation()}
        />
      ) : null}
      <IconButton
        icon="cog-outline"
        size={20}
        onPress={() => setSettingsVisible(true)}
      />
    </View>
  );

  return (
    <UserContext.Provider value={user}>
      <ImageBackground
        source={require('../../assets/images/bg-hermes.png')}
        style={{flex: 1}}
        resizeMode="cover">
        {/* 背景是暗色，浅色系统下默认的深色状态栏图标会看不见 */}
        <StatusBar
          barStyle="light-content"
          backgroundColor="transparent"
          translucent
        />
        <ChatScaffold
          backgroundColor="transparent"
          chatAreaBackgroundColor="transparent"
          onLayout={onRootLayout}
          header={header}
          pendingIndicator={
            hermesStore.status === 'connecting' ? (
              <PendingIndicator
                pendingTalentNames={[]}
                toolCallTokenCount={0}
              />
            ) : null
          }
          showListHeaderSpacer={chatMessages.length > 0}
          onInputLayout={onInputLayout}
          list={({renderListHeader}) => (
            <FlatList
              data={chatMessages}
              inverted={chatMessages.length > 0}
              keyExtractor={item => item.id}
              renderItem={renderMessage}
              ListHeaderComponent={renderListHeader}
              ListEmptyComponent={
                <View style={{padding: 32, alignItems: 'center', gap: 12}}>
                  <Text variant="titleMedium">Hermes 远程对话</Text>
                  <Text
                    variant="bodyMedium"
                    style={{textAlign: 'center', opacity: 0.7}}>
                    {configured ? '发一条消息试试' : '先填服务器地址和 API Key'}
                  </Text>
                  {!configured && (
                    <Button
                      mode="contained"
                      onPress={() => setSettingsVisible(true)}>
                      打开设置
                    </Button>
                  )}
                </View>
              }
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: chatMessages.length ? undefined : 'center',
              }}
              style={{marginBottom: inputSize.height}}
              keyboardDismissMode={
                Platform.OS === 'ios' ? 'interactive' : 'none'
              }
              showsVerticalScrollIndicator={false}
            />
          )}
          input={
            <>
              {hermesStore.error ? (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: theme.colors.errorContainer,
                  }}>
                  <Text
                    variant="bodySmall"
                    style={{flex: 1, color: theme.colors.onErrorContainer}}>
                    {hermesStore.error}
                  </Text>
                  <Button
                    compact
                    mode="text"
                    textColor={theme.colors.onErrorContainer}
                    onPress={() => void hermesStore.retry()}>
                    重试
                  </Button>
                </View>
              ) : null}
              <ChatInput
                modelReady
                onSendPress={handleSendPress}
                isStreaming={hermesStore.status === 'streaming'}
                onStopPress={() => hermesStore.stop()}
                isStopVisible={hermesStore.isBusy}
                sendButtonVisibilityMode="always"
                inputBackgroundColor={theme.colors.background}
                textInputProps={{
                  editable: configured,
                  placeholder: configured
                    ? '发消息给 Hermes…'
                    : '先配置服务器地址',
                }}
              />
            </>
          }
        />
      </ImageBackground>
      <HermesSettingsSheet
        isVisible={settingsVisible}
        onDismiss={() => setSettingsVisible(false)}
      />
    </UserContext.Provider>
  );
});
