import React, {useCallback, useState} from 'react';
import {
  LayoutAnimation,
  LayoutChangeEvent,
  Platform,
  StyleSheet,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import {Text} from 'react-native-paper';
import LinearGradient from 'react-native-linear-gradient';

import {ChevronDownIcon, ChevronUpIcon} from '../assets/icons';
import {useTheme} from '../hooks';

// Enable LayoutAnimation for Android (no-op if already enabled elsewhere).
if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Height used for the bottom fade — one line of body text, roughly. */
const FADE_HEIGHT = 32;

/** Tolerance (px) so sub-pixel rounding doesn't trigger a bogus "expand". */
const OVERFLOW_EPSILON = 1;

export interface CollapsibleContentProps {
  /** Content to clamp. Any layout content — markdown renderers included. */
  children?: React.ReactNode;
  /** Number of lines visible while collapsed. Defaults to 6. */
  maxLines?: number;
  /** Line height used to turn `maxLines` into a pixel height. */
  lineHeight?: number;
  /**
   * Optional controlled expanded state. When omitted the component owns
   * its own state (uncontrolled).
   */
  expanded?: boolean;
  /** Start expanded in uncontrolled mode. Defaults to false. */
  defaultExpanded?: boolean;
  /**
   * Called on every user toggle. In controlled mode the parent is
   * expected to feed `expanded` back in.
   */
  onToggle?: (expanded: boolean) => void;
  /** Label on the toggle while collapsed. */
  expandLabel?: string;
  /** Label on the toggle while expanded. */
  collapseLabel?: string;
  /**
   * Color the bottom fade blends into. Should match the surface the
   * content sits on (e.g. the message bubble background).
   */
  fadeColor?: string;
  testID?: string;
}

/**
 * Clamps tall content to `maxLines` lines with a bottom fade + a
 * "Show more" toggle. Nothing happens (no fade, no toggle) when the
 * content already fits — overflow is detected by measuring the natural
 * height of the content against the clamped height.
 *
 * The measurement relies on the inner measuring view keeping its
 * natural height (`flexShrink: 0`) while the clipping parent carries
 * `maxHeight` + `overflow: 'hidden'`.
 */
export const CollapsibleContent: React.FC<CollapsibleContentProps> = ({
  children,
  maxLines = 6,
  lineHeight: lineHeightProp,
  expanded,
  defaultExpanded = false,
  onToggle,
  expandLabel = 'Show more',
  collapseLabel = 'Show less',
  fadeColor,
  testID = 'collapsible-content',
}) => {
  const theme = useTheme();
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [contentHeight, setContentHeight] = useState(0);

  const isControlled = expanded !== undefined;
  const isExpanded = isControlled ? expanded : internalExpanded;

  const bodyLineHeight =
    lineHeightProp ??
    (theme.fonts.bodyMedium?.lineHeight ||
      Math.round((theme.fonts.bodyMedium?.fontSize ?? 16) * 1.4));

  const clampedHeight = maxLines * bodyLineHeight;

  // Content shorter than the clamp (or not measured yet) never collapses.
  const isOverflowing = contentHeight > clampedHeight + OVERFLOW_EPSILON;
  const isClamped = isOverflowing && !isExpanded;

  const handleContentLayout = useCallback((event: LayoutChangeEvent) => {
    const {height} = event.nativeEvent.layout;
    // Guard against redundant layout passes / state loops.
    setContentHeight(prev => (Math.abs(prev - height) > 0.5 ? height : prev));
  }, []);

  const handleToggle = useCallback(() => {
    LayoutAnimation.configureNext({
      duration: 220,
      update: {type: LayoutAnimation.Types.easeInEaseOut},
    });
    const next = !isExpanded;
    if (!isControlled) {
      setInternalExpanded(next);
    }
    onToggle?.(next);
  }, [isControlled, isExpanded, onToggle]);

  const toggleLabel = isExpanded ? collapseLabel : expandLabel;

  return (
    <View testID={testID}>
      <View
        style={[
          styles.clipContainer,
          isClamped ? {maxHeight: clampedHeight} : null,
        ]}>
        <View style={styles.measureContainer} onLayout={handleContentLayout}>
          {children}
        </View>

        {isClamped ? (
          <View
            pointerEvents="none"
            style={styles.fadeContainer}
            testID={`${testID}-fade`}>
            <LinearGradient
              style={styles.fadeGradient}
              colors={['transparent', fadeColor ?? theme.colors.background]}
            />
          </View>
        ) : null}
      </View>

      {isOverflowing ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{expanded: isExpanded}}
          accessibilityLabel={toggleLabel}
          activeOpacity={0.6}
          onPress={handleToggle}
          style={styles.toggleRow}
          testID={`${testID}-toggle`}>
          <Text
            variant="labelMedium"
            style={[styles.toggleLabel, {color: theme.colors.primary}]}>
            {toggleLabel}
          </Text>
          <View style={styles.toggleIcon}>
            {isExpanded ? (
              <ChevronUpIcon
                width={14}
                height={14}
                stroke={theme.colors.primary}
              />
            ) : (
              <ChevronDownIcon
                width={14}
                height={14}
                stroke={theme.colors.primary}
              />
            )}
          </View>
        </TouchableOpacity>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  clipContainer: {
    overflow: 'hidden',
    position: 'relative',
  },
  measureContainer: {
    // Keep the natural height so onLayout reports the full content
    // height even while the parent clamps via maxHeight.
    flexShrink: 0,
  },
  fadeContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: FADE_HEIGHT,
  },
  fadeGradient: {
    flex: 1,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingTop: 6,
    paddingBottom: 2,
    paddingHorizontal: 2,
    gap: 4,
  },
  toggleLabel: {
    letterSpacing: 0.2,
  },
  toggleIcon: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});
