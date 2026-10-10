import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { colors } from '../theme';
import { Header } from './Header';
const meta = {
  title: 'Kiosk/Header',
  component: Header,
  decorators: [
    (Story) => (
      // Backdrop only: the v3 header lives on blue and night screens.
      <View style={{ backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: {
    locale: 'ru',
    setLocale: fn(),
    onCancel: fn(),
    onHelp: fn(),
    back: fn(),
    mode: 'С собой',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Header>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Checkout = { args: { title: 'Как оплатите?' } };
/** The dining mode follows the subtitle with its own icon (bag to go, plate to eat in). */
export const EatIn = {
  args: { title: 'Ваш заказ', subtitle: '2 позиции', mode: 'В зале', modeKind: 'dine_in' },
};
export const LongTitle = {
  args: {
    locale: 'en',
    title: 'How would you like to pay?',
    subtitle: '2 items',
    mode: 'Take away',
    modeKind: 'takeaway',
  },
};
/** Payment: the footer owns the way out, so the header has no cancel. */
export const NoCancel = { args: { title: 'Оплата заказа', cancellable: false, back: undefined } };
export const Menu = {
  args: {
    back: undefined,
    title: 'Меню',
    subtitle: 'ТЦ Abay Plaza',
    dining: 'dine_in',
    onDining: fn(),
  },
};
