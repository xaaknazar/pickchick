import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { PaymentMethodCard } from './PaymentMethodCard';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/PaymentMethodCard',
  component: PaymentMethodCard,
  decorators: [
    (Story) => (
      // Backdrop only: payment choices sit on the blue v3 review screen.
      <View style={{ flex: 1, backgroundColor: colors.blue }}>
        <Wrapper padding={28}>
          <Story />
        </Wrapper>
      </View>
    ),
  ],
  args: {
    method: 'kaspi',
    selected: true,
    busy: false,
    commercial: true,
    locale: 'ru',
    onSelect: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentMethodCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const PhoneInvoice: Story = { args: { method: 'kaspi_invoice' } };
export const PhoneInvoiceKk: Story = {
  args: { method: 'kaspi_invoice', locale: 'kk', selected: false },
};
export const TestCard = { args: { method: 'card', commercial: false, selected: false } };
export const TestKaspi = { args: { commercial: false } };
