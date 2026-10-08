import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { product } from '../stories/fixtures';
import { ProductArtwork } from './ProductArtwork';
import { ProductToolbar } from './ProductToolbar';
const meta = {
  title: 'Kiosk/ProductToolbar',
  component: ProductToolbar,
  decorators: [
    (Story) => (
      // The toolbar floats over the product photo stage.
      <View>
        <ProductArtwork imageId={product.image_id} variant="hero" />
        <Story />
      </View>
    ),
  ],
  args: { locale: 'ru', onClose: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductToolbar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const SetWizard = { args: { step: 1, steps: 2 } };
export const SetWizardExtras = { args: { step: 2, steps: 2 } };
