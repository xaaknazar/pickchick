import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { product } from '../stories/fixtures';
import { colors } from '../theme';
import { ProductNutrition } from './ProductNutrition';
const meta = {
  title: 'Kiosk/ProductNutrition',
  component: ProductNutrition,
  decorators: [
    (Story) => (
      // Backdrop only: v3 nutrition sits on the blue product page.
      <View style={{ backgroundColor: colors.blue, padding: 36 }}>
        <Story />
      </View>
    ),
  ],
  args: { product, locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductNutrition>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Facts: Story = { args: { part: 'facts' } };
export const Details: Story = { args: { part: 'details' } };
export const Kazakh = { args: { locale: 'kk' } };
