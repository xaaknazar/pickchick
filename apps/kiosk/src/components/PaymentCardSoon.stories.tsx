import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { PaymentCardSoon } from './PaymentCardSoon';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/PaymentCardSoon',
  component: PaymentCardSoon,
  decorators: [
    (Story) => (
      // Backdrop only: the card option is drawn on the blue payment footer.
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: { locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentCardSoon>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh: Story = { args: { locale: 'kk' } };
