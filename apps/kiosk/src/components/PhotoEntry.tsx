import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Locale } from '../i18n';
import { photoCopy } from '../photobooth/copy';
import { colors, fonts } from '../theme';
import { fixedText } from './Body';
import { PhotoBooth } from './PhotoBooth';

export function PhotoEntry({
  locale,
  onInteraction,
}: {
  locale: Locale;
  onInteraction: () => void;
}) {
  const [open, setOpen] = useState(false);
  const t = photoCopy(locale);
  return (
    <View style={{ paddingHorizontal: 24, paddingBottom: 16, alignItems: 'flex-end' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.title}
        testID="photo-open"
        onPress={() => {
          onInteraction();
          setOpen(true);
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 52,
          paddingHorizontal: 20,
          borderRadius: 16,
          backgroundColor: pressed ? colors.sky : colors.white,
        })}
      >
        <Ionicons name="camera-outline" size={24} color={colors.blue} accessible={false} />
        <Text {...fixedText} style={{ color: colors.blue, fontFamily: fonts.bold, fontSize: 18 }}>
          {t.title}
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
