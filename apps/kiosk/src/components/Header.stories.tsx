import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Header } from './Header';
const meta = {
  title: 'Kiosk/Header',
  component: Header,
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
