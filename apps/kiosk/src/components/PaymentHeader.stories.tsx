import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { PaymentHeader } from './PaymentHeader';
const meta = {
  title: 'Kiosk/Redesign/PaymentHeader',
  component: PaymentHeader,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Story />
      </ScreenSurface>
    ),
  ],
  args: {
    locale: 'ru',
    setLocale: fn(),
    title: 'Оплата',
    subtitle: 'Заказ № 42 · С собой',
    onHelp: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** The number is not known yet: only the dining mode. */
export const WithoutNumber: Story = { args: { subtitle: 'В зале' } };
export const Kazakh: Story = {
  args: { locale: 'kk', title: 'Төлем', subtitle: 'Тапсырыс № 42 · Өзіммен' },
};
export const English: Story = {
  args: { locale: 'en', title: 'Payment', subtitle: 'Order #42 · Takeaway' },
};
