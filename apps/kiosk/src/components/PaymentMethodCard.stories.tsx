import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { PaymentMethodCard } from './PaymentMethodCard';
const meta = {
  title: 'Kiosk/PaymentMethodCard',
  component: PaymentMethodCard,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
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
export const TestCard = { args: { method: 'card', commercial: false, selected: false } };
