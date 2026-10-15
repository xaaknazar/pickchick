import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Modal, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Locale } from '../i18n';
import { photoCopy } from '../photobooth/copy';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { PhotoBooth } from './PhotoBooth';
import { useMotionPreference } from './useMotionPreference';

const invitation = {
  ru: { title: 'Улыбнёмся?', detail: 'Фото на память' },
  kk: { title: 'Күлімдейік!', detail: 'Естелік фото' },
  en: { title: 'Say cheese!', detail: 'A photo to keep' },
};

export function PhotoEntry({
  locale,
  onInteraction = () => {},
  disabled = false,
}: {
  locale: Locale;
  onInteraction?: () => void;
  disabled?: boolean;
}) {
  const { px } = useMetrics();
  const [open, setOpen] = useState(false);
  const reduced = useMotionPreference();
  const pose = useRef(new Animated.Value(0)).current;
  const t = photoCopy(locale);
  const message = invitation[locale];
  useEffect(() => {
    pose.setValue(0);
    if (reduced || open || disabled) return;
    const to = (value: number, duration: number) =>
      Animated.timing(pose, {
        toValue: value,
        duration,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      });
    // A small lean towards the guest, a camera pose, then a long still pause.
    const greeting = Animated.loop(
      Animated.sequence([
        Animated.delay(1800),
        to(-1, 420),
        to(1, 650),
        to(0, 420),
        Animated.delay(300),
        to(0.45, 350),
        to(0, 450),
        Animated.delay(7000),
      ]),
    );
    greeting.start();
    return () => {
      greeting.stop();
      pose.setValue(0);
    };
  }, [disabled, open, pose, reduced]);
  return (
    <View testID="photo-entry">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.capture}
        accessibilityHint={message.detail}
        accessibilityState={{ disabled }}
        disabled={disabled}
        testID="photo-open"
        onPress={() => {
          onInteraction();
          setOpen(true);
        }}
        style={({ pressed }) => ({
          alignItems: 'center',
          borderRadius: px(22),
          paddingTop: px(10),
          paddingHorizontal: px(8),
          paddingBottom: px(8),
          backgroundColor: pressed ? colors.sky : colors.cream,
          opacity: disabled ? 0.55 : 1,
        })}
      >
        <Text
          {...fixedText}
          style={{
            color: colors.navy,
            fontFamily: fonts.heavy,
            fontSize: Math.max(16, px(19)),
            textAlign: 'center',
          }}
        >
          {message.title}
        </Text>
        <Animated.View
          testID="photo-alex"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          style={{
            width: '100%',
            height: px(134),
            marginVertical: px(3),
            transform: [
              {
                rotate: pose.interpolate({
                  inputRange: [-1, 0, 1],
                  outputRange: ['-5deg', '0deg', '5deg'],
                }),
              },
              {
                translateY: pose.interpolate({ inputRange: [-1, 0, 1], outputRange: [-2, 0, -4] }),
              },
              {
                scale: pose.interpolate({ inputRange: [-1, 0, 1], outputRange: [1.01, 1, 1.035] }),
              },
            ],
          }}
        >
          <Image
            source={require('../../../../design/photo-alex/alex-camera.png')}
            resizeMode="contain"
            accessible={false}
            style={{ width: '100%', height: '100%' }}
          />
        </Animated.View>
        <Text
          {...fixedText}
          style={{
            color: colors.navy,
            fontFamily: fonts.body,
            fontSize: Math.max(14, px(16)),
            textAlign: 'center',
            marginBottom: px(8),
          }}
        >
          {message.detail}
        </Text>
        <View
          style={{
            minHeight: 48,
            alignSelf: 'stretch',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: px(6),
            backgroundColor: colors.blue,
            borderRadius: px(14),
            paddingHorizontal: px(6),
            paddingVertical: px(8),
          }}
        >
          <Ionicons name="camera-outline" size={20} color={colors.white} accessible={false} />
          <Text
            {...fixedText}
            style={{
              color: colors.white,
              fontFamily: fonts.bold,
              fontSize: Math.max(15, px(17)),
              textAlign: 'center',
              flexShrink: 1,
            }}
          >
            {t.capture}
          </Text>
        </View>
      </Pressable>
      <Modal
        visible={open}
        presentationStyle="fullScreen"
        animationType={reduced ? 'none' : 'fade'}
        onRequestClose={() => setOpen(false)}
      >
        {open ? (
          <PhotoBooth
            locale={locale}
            onInteraction={onInteraction}
            onClose={() => {
              onInteraction();
              setOpen(false);
            }}
          />
        ) : null}
      </Modal>
    </View>
  );
}
