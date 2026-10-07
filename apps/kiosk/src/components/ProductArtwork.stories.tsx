import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { product } from '../stories/fixtures';
import { ProductArtwork } from './ProductArtwork';
const meta = {
  title: 'Kiosk/ProductArtwork',
  component: ProductArtwork,
  args: { imageId: product.image_id },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductArtwork>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Recommendation: Story = { args: { variant: 'recommendation' } };
export const Thumbnail = { args: { variant: 'thumbnail' } };
export const MissingDrinkPhoto = { args: { imageId: 'generic-drink' } };
