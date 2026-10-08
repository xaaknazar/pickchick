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
export const Peach: Story = { args: { imageId: 'i1.jpg', variant: 'feature' } };
export const Water: Story = { args: { imageId: 'i23.jpg' } };
export const ColaBottle: Story = { args: { imageId: 'drink:cola-bottle', variant: 'option' } };
export const ColaCan: Story = { args: { imageId: 'i2.jpg' } };
export const ColaZero: Story = { args: { imageId: 'drink:cola-zero' } };
export const Sprite: Story = { args: { imageId: 'drink:sprite' } };
export const Fanta: Story = { args: { imageId: 'drink:fanta' } };
export const MangoChamomile: Story = { args: { imageId: 'drink:fuse-mango' } };
export const PikoApple: Story = { args: { imageId: 'drink:piko-apple' } };
export const PikoOrange: Story = { args: { imageId: 'drink:piko-orange' } };
export const PikoBothFlavors: Story = { args: { imageId: 'drink:piko' } };
