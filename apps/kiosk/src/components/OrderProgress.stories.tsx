import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { colors } from '../theme';
import { OrderProgress } from './OrderProgress';
const meta = {
  title: 'Kiosk/OrderProgress',
  component: OrderProgress,
  decorators: [
    (Story) => (
      // Backdrop only: the step strip is drawn for blue v3 surfaces.
      <View style={{ backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: { step: 'menu', locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof OrderProgress>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Payment = { args: { step: 'payment' } };
