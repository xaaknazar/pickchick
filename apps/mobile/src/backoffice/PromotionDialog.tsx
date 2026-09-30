import { MotionModal as Modal } from '../components/Motion';
import { ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { API_URL } from '../api';
import { Body, Button, Heading } from '../components/UI';
import type { PublishedContent } from './content-model';
export function PromotionDialog({
  promotion,
  onClose,
}: {
  promotion: PublishedContent['promos'][number] | null;
  onClose(): void;
}) {
  if (!promotion) return null;
  const key = promotion.image_asset_key;
  const file = key === 'logo' ? 'logo.png' : key === 'generic-drink' ? null : key + '.jpg';
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView testID="promotion-dialog" style={{ flex: 1, backgroundColor: '#04143A' }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 20 }}>
          {file ? (
            <Image
              source={{ uri: `${API_URL}/backoffice/assets/${file}` }}
              style={{ width: '100%', aspectRatio: 1.7, borderRadius: 20 }}
              contentFit="contain"
            />
          ) : null}
          <Heading>{promotion.title.ru}</Heading>
          <Body>{promotion.body.ru}</Body>
        </ScrollView>
        <View style={{ padding: 24 }}>
          <Button title="Закрыть" onPress={onClose} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}
