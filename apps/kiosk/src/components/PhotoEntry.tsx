import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Locale } from '../i18n';
import { photoCopy } from '../photobooth/copy';
import { colors, fonts, useMetrics } from '../theme';
import { fixedText } from './Body';
import { PhotoBooth } from './PhotoBooth';

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
  const t = photoCopy(locale);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.capture}
        accessibilityState={{ disabled }}
        disabled={disabled}
        testID="photo-open"
        onPress={() => {
          onInteraction();
          setOpen(true);
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          minHeight: Math.max(56, px(75)),
          paddingHorizontal: Math.max(20, px(26)),
          borderRadius: 16,
          backgroundColor: pressed ? colors.sky : colors.white,
        })}
      >
        <Ionicons name="camera-outline" size={24} color={colors.blue} accessible={false} />
        <Text
          {...fixedText}
          style={{ color: colors.blue, fontFamily: fonts.bold, fontSize: Math.max(18, px(22)) }}
        >
          {t.capture}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        presentationStyle="fullScreen"
        animationType="fade"
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
