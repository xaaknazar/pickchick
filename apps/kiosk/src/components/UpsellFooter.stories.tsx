import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { Wrapper } from './Wrapper';
import { UpsellFooter } from './UpsellFooter';
const meta = {
  title: 'Kiosk/Redesign/UpsellFooter',
  component: UpsellFooter,
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
    items: 'Pick Combo',
    total: '419000',
    valid: true,
    disabled: false,
    busy: false,
    locale: 'ru',
    onCart: fn(),
    onSkip: fn(),
    onPay: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof UpsellFooter>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithSauce: Story = {
  args: { items: 'Burger Combo + Соус фирменный', total: '418000' },
};
export const Kazakh: Story = { args: { locale: 'kk' } };
export const English: Story = { args: { locale: 'en' } };
/** Payment is closed (an unavailable line, an empty order or checkout off). */
export const Disabled: Story = { args: { disabled: true } };
export const CheckCart: Story = { args: { valid: false, disabled: true } };
export const Busy: Story = { args: { busy: true } };
