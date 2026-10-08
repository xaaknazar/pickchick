import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { productArtworkId } from '../assets';
import { PhotoImage } from './PhotoImage';
const meta = {
  title: 'Kiosk/PhotoImage',
  component: PhotoImage,
  decorators: [
    (Story) => (
      <View style={{ width: 260, height: 260 }}>
        <Story />
      </View>
    ),
  ],
  args: { imageId: 'i1.jpg' },
  tags: ['autodocs'],
} satisfies Meta<typeof PhotoImage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const PikoBothFlavors: Story = { args: { imageId: 'drink:piko' } };
export const OrangeInCart: Story = { args: { imageId: 'drink:piko-orange', variant: 'cart' } };
export const ComboHero: Story = { args: { imageId: 'i7.jpg', variant: 'hero' } };
export const BottleOption: Story = { args: { imageId: 'cola-bottle', variant: 'option' } };
// A published photo whose remote rendition cannot load (offline, not yet cached) falls back to
// the bundled photo of the same image key.
const offlineId = productArtworkId({
  id: 'story-offline-photo',
  image_id: 'i7.jpg',
  media: {
    sha256: 'a'.repeat(64),
    card: `/v1/media/catalog/${'a'.repeat(64)}.card.webp`,
    hero: `/v1/media/catalog/${'b'.repeat(64)}.hero.webp`,
    thumb: `/v1/media/catalog/${'c'.repeat(64)}.thumb.webp`,
  },
})!;
export const RemoteOfflineFallsBack: Story = { args: { imageId: offlineId } };
