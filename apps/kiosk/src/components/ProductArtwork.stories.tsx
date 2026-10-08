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
export const Hero: Story = { args: { variant: 'hero' } };
export const HeroSingle: Story = { args: { variant: 'hero', imageId: 'i0.jpg' } };
export const HeroCutout: Story = { args: { variant: 'hero', imageId: 'i18.jpg' } };
export const Recommendation: Story = { args: { variant: 'recommendation' } };
export const Thumbnail = { args: { variant: 'thumbnail' } };
export const MissingDrinkPhoto = { args: { imageId: 'generic-drink' } };
