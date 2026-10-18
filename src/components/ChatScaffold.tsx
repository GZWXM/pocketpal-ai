import * as React from 'react';
import {
  LayoutChangeEvent,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';

import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useReanimatedKeyboardAnimation} from 'react-native-keyboard-controller';
import Reanimated, {
  SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from 'react-native-reanimated';

import type {Theme} from '../utils/types';
import {useTheme} from '../hooks';

/**
 * ChatScaffold
 * ============
 * The *layout* half of a chat screen, with no opinion about where the messages
 * come from. It owns everything that must be identical between two chat
 * surfaces of the same app:
 *
 * - the keyboard-avoidance reconciliation (`keyboardOcclusion`) and the
 *   derived transforms that every keyboard-tracking element shares, so the
 *   input bar, the floating overlays and the list's bottom spacer can never
 *   disagree;
 * - the input bar's sticky-to-bottom position (absolute, `bottom: 0`,
 *   themed top radius + shadow) and the safe-area padding it applies while
 *   the keyboard is closed;
 * - the inverted list's `ListHeaderComponent`, which is where the pending
 *   indicator lives (an inverted list renders its header at the *bottom*, i.e.
 *   below the latest turn) plus the keyboard spacer that lifts the newest
 *   message above the input bar;
 * - the container/header/list/input stacking (`zIndex`) so overlays keep the
 *   same paint order as before.
 *
 * Data, message rendering, scroll tracking and everything else stay in the
 * consumer (see `ChatView`).
 */
export interface ChatScaffoldListContext {
  /**
   * `ListHeaderComponent` for an inverted list: the pending indicator (when
   * `pendingIndicator` is supplied) plus the keyboard spacer. Pass it straight
   * to `<FlatList inverted ListHeaderComponent={renderListHeader} />`.
   */
  renderListHeader: () => React.ReactElement;
  /** Reconciled keyboard occlusion above the input bar, in px. */
  keyboardOcclusion: SharedValue<number>;
}

export interface ChatScaffoldOverlayContext {
  /** Reconciled keyboard occlusion above the input bar, in px. */
  keyboardOcclusion: SharedValue<number>;
  /**
   * `transform: [{translateY: -occlusion}]` — apply it to floating elements
   * that should ride up with the input bar. It deliberately carries no
   * `paddingBottom`, so it must not be used for the input bar itself.
   */
  keyboardTranslateStyle: React.ComponentProps<typeof Reanimated.View>['style'];
}

export interface ChatScaffoldProps {
  /** Fixed bar above the chat area (chat header). */
  header?: React.ReactNode;
  /** Content shown between the header and the list (banners etc.). */
  children?: React.ReactNode;
  /** The message list area. Receives the inverted-list header factory. */
  list: (ctx: ChatScaffoldListContext) => React.ReactNode;
  /**
   * Pending indicator, rendered at the bottom of the inverted list (below the
   * latest turn, never inside it). Omitted/null hides it.
   */
  pendingIndicator?: React.ReactNode;
  /** Render the list's keyboard spacer. Callers pass "list is non-empty". */
  showListHeaderSpacer?: boolean;
  /** Input bar content (`ChatInput` + banners). Pinned to the bottom. */
  input: React.ReactNode;
  /**
   * Elements floating above the input bar inside the chat container
   * (suggested prompts, picker sheets). They share the input's keyboard
   * translation but get no wrapper view, so they stay direct children of the
   * chat container — same stacking as before.
   */
  inputOverlay?: (ctx: ChatScaffoldOverlayContext) => React.ReactNode;
  /**
   * Root-level siblings of the chat container (image viewers, menus, sheets,
   * snackbars). Rendered after it so they keep the same stacking order.
   */
  overlays?: React.ReactNode;
  /** Safe to use for size tracking: forwarded to the root view. */
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Forwarded to the input container; use it to measure the input height. */
  onInputLayout?: (event: LayoutChangeEvent) => void;
  /** Background of the root view and of the input bar. */
  backgroundColor?: string;
  /**
   * Background of the chat area only. Pass 'transparent' when an
   * ImageBackground wraps the scaffold (Hermes screen). Omit to keep the
   * theme background.
   */
  chatAreaBackgroundColor?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const createStyles = ({theme}: {theme: Theme}) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    headerWrapper: {
      zIndex: 100,
    },
    chatContainer: {
      flex: 1,
      position: 'relative',
      backgroundColor: theme.colors.background,
      zIndex: 0,
    },
    inputContainer: {
      borderTopLeftRadius: theme.borders.inputBorderRadius,
      borderTopRightRadius: theme.borders.inputBorderRadius,
      position: 'absolute',
      zIndex: 10,
      left: 0,
      right: 0,
      bottom: 0,
      ...(!theme.dark
        ? {
            boxShadow: `0px -2px 8px ${theme.colors.shadow}1A`,
          }
        : {}),
    },
  });

export const ChatScaffold: React.FC<ChatScaffoldProps> = ({
  header,
  children,
  list,
  pendingIndicator,
  showListHeaderSpacer = false,
  input,
  inputOverlay,
  overlays,
  onLayout,
  onInputLayout,
  backgroundColor,
  chatAreaBackgroundColor,
  style,
  testID,
}) => {
  const theme = useTheme();
  const styles = React.useMemo(() => createStyles({theme}), [theme]);
  const insets = useSafeAreaInsets();

  // ============ KEYBOARD ANIMATION SETUP ============
  // Get real-time keyboard height from the keyboard controller
  const keyboard = useReanimatedKeyboardAnimation();

  // One reconciled "keyboard occlusion above the input" value. The library
  // reports a negative `keyboard.height` while the keyboard is up; the IME
  // inset already spans the navigation bar (KeyboardProvider is configured
  // navigationBarTranslucent), so the space the keyboard actually steals from
  // the chat surface is the IME inset minus the safe-area bottom inset. One
  // expression, correct on every API level — there is no version fork (the
  // API ≤ 29 under-reservation is handled by the clamp, not a branch). The
  // input translate, the suggested-prompts overlay, and the inverted-list
  // bottom spacer all derive from THIS value so they never disagree.
  const keyboardOcclusion = useDerivedValue(() =>
    Math.max(0, Math.abs(keyboard.height.value) - insets.bottom),
  );

  // Shared value to track if keyboard is visible (height > 0)
  const isKeyboardVisible = useSharedValue(false);

  // Animated style for input container padding
  // Apply bottom padding (safe area inset) only when keyboard is NOT visible
  const inputContainerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{translateY: -keyboardOcclusion.value}],
    paddingBottom: isKeyboardVisible.value ? 0 : insets.bottom,
  }));

  // Overlays share the input's keyboard translation but must NOT inherit
  // paddingBottom (which the input uses to clear the home indicator). Applying
  // it here would create a large empty gap between the chips and the input
  // when the keyboard is closed.
  const keyboardTranslateStyle = useAnimatedStyle(() => ({
    transform: [{translateY: -keyboardOcclusion.value}],
  }));

  // ListHeaderComponent as animated spacer (inverted list: header is at bottom)
  // We use this to create a spacer at the bottom of the list to account for the
  // keyboard height, so the newest turn rises above the input when the keyboard
  // opens. Reads the SAME reconciled occlusion value as the input translate, so
  // the two can never disagree, and holds while the keyboard is settled-open
  // (it returns to 0 only when the keyboard closes, not while it merely stops
  // moving — the previous in-flight gate dropped it too early on API ≤ 29).
  const headerStyle = useAnimatedStyle(() => ({
    height: keyboardOcclusion.value,
  }));

  // The pending indicator lives behind a ref so that `renderListHeader` stays
  // referentially stable while the indicator toggles content-wise. FlatList
  // re-renders the header component on every list render, so the freshest
  // element is always what gets mounted; keeping the identity stable is what
  // prevents FlatList from unmounting/remounting the header (which would kill
  // the indicator's dot animations and elapsed-seconds timer).
  const pendingIndicatorRef = React.useRef(pendingIndicator);
  pendingIndicatorRef.current = pendingIndicator;

  const renderListHeader = React.useCallback(
    () => (
      <>
        {pendingIndicatorRef.current}
        {showListHeaderSpacer ? <Reanimated.View style={headerStyle} /> : null}
      </>
    ),
    [showListHeaderSpacer, headerStyle],
  );

  const listContext = React.useMemo<ChatScaffoldListContext>(
    () => ({renderListHeader, keyboardOcclusion}),
    [renderListHeader, keyboardOcclusion],
  );

  const overlayContext = React.useMemo<ChatScaffoldOverlayContext>(
    () => ({keyboardOcclusion, keyboardTranslateStyle}),
    [keyboardOcclusion, keyboardTranslateStyle],
  );

  const backgroundStyle = React.useMemo(
    () => (backgroundColor ? {backgroundColor} : undefined),
    [backgroundColor],
  );

  return (
    <View
      style={[styles.container, backgroundStyle, style]}
      onLayout={onLayout}
      testID={testID}>
      {header ? <View style={styles.headerWrapper}>{header}</View> : null}

      <Reanimated.View
        style={[
          styles.chatContainer,
          chatAreaBackgroundColor !== undefined && {
            backgroundColor: chatAreaBackgroundColor,
          },
        ]}>
        {children}
        {list(listContext)}

        <Reanimated.View
          style={[
            styles.inputContainer,
            inputContainerAnimatedStyle,
            backgroundStyle,
          ]}
          onLayout={onInputLayout}>
          {input}
        </Reanimated.View>

        {inputOverlay ? inputOverlay(overlayContext) : null}
      </Reanimated.View>

      {overlays}
    </View>
  );
};
