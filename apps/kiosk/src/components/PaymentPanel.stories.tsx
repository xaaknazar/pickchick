import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { Wrapper } from './Wrapper';
import { catalog, line } from '../stories/fixtures';
import type { KioskCartLine } from '../model';
import { PaymentPanel } from './PaymentPanel';
const extra = (id: string): KioskCartLine => {
  const product = catalog.products.find((p) => p.id === id) ?? catalog.products[1]!;
  return {
    lineId: 'story-' + product.id,
    productId: product.id,
    quantity: 1,
    selections: [],
    product,
    unitPriceMinor: product.price_minor,
    lineTotalMinor: product.price_minor,
  };
};
const meta = {
  title: 'Kiosk/Redesign/PaymentPanel',
  component: PaymentPanel,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Wrapper flex={1} />
        <Story />
      </ScreenSurface>
    ),
  ],
  args: {
    lines: [line, extra('sauce'), extra('cola')],
    checking: false,
    busy: false,
    locale: 'ru',
    restart: true,
    onRestart: fn(),
    actionLabel: 'Позвать сотрудника',
    onAction: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof PaymentPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Live Kaspi QR: «Начать заново» beside «Позвать сотрудника». */
export const Default: Story = {};
/** Restart not allowed (e.g. the list of abandoned guests is full): staff only, as before. */
export const StaffOnly: Story = { args: { restart: false } };
export const Checking: Story = { args: { checking: true } };
export const Kazakh: Story = { args: { locale: 'kk', actionLabel: 'Қызметкерді шақыру' } };
export const English: Story = { args: { locale: 'en', actionLabel: 'Call a team member' } };
