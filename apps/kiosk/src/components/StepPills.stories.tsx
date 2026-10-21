import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { StepPills } from './StepPills';
const meta = {
  title: 'Kiosk/Redesign/StepPills',
  component: StepPills,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Story />
      </ScreenSurface>
    ),
  ],
  args: { current: 'extras', locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof StepPills>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Smart upsell: Меню done, Допы current, Оплата and Номер заказа ahead. */
export const Extras: Story = {};
export const Kazakh: Story = { args: { locale: 'kk' } };
export const English: Story = { args: { locale: 'en' } };
export const Payment: Story = { args: { current: 'payment' } };
