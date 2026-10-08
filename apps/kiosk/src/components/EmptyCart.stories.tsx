import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { EmptyCart } from './EmptyCart';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/EmptyCart',
  component: EmptyCart,
  decorators: [
    (Story) => (
      // Backdrop only: the empty state uses white copy on the blue v3 cart.
      <View style={{ flex: 1, backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: { locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof EmptyCart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
