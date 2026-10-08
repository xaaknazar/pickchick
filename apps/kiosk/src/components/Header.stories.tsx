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
