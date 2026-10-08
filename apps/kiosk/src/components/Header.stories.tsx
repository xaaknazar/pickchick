import { useState } from 'react';
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
/** The mode chip pulses (.9 -> 1.05 -> 1) whenever the mode changes. */
export const ModeChange: Story = {
  render: function ModeChangeStory(args) {
    const [here, setHere] = useState(false);
    return (
      <Header
        {...args}
        mode={here ? 'Здесь' : 'С собой'}
        onMode={() => setHere((value) => !value)}
      />
    );
  },
};
export const Menu = {
  args: {
    back: undefined,
    title: 'Меню',
    subtitle: 'ТЦ Abay Plaza',
    dining: 'dine_in',
    onDining: fn(),
  },
};
