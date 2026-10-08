import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { colors } from '../theme';
import { DiningSwitch } from './DiningSwitch';
const meta = {
  title: 'Kiosk/DiningSwitch',
  component: DiningSwitch,
  decorators: [
    (Story) => (
      // Backdrop only: the switch sits in the blue menu header.
      <View style={{ padding: 28, alignItems: 'flex-start', backgroundColor: colors.blue }}>
        <Story />
      </View>
    ),
  ],
  args: { mode: 'dine_in', locale: 'ru', onChange: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof DiningSwitch>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DineIn: Story = {};
export const Takeaway: Story = { args: { mode: 'takeaway' } };
export const Kazakh: Story = { args: { locale: 'kk' } };
export const Busy: Story = { args: { disabled: true } };
