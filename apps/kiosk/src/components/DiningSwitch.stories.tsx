import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { redesign } from '../theme';
import { DiningSwitch } from './DiningSwitch';
const meta = {
  title: 'Kiosk/DiningSwitch',
  component: DiningSwitch,
  decorators: [
    (Story) => (
      // Backdrop only: the glass switch sits in the redesigned blue menu header.
      <View style={{ padding: 28, alignItems: 'flex-start', backgroundColor: redesign.screen[1] }}>
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
export const English: Story = { args: { locale: 'en', mode: 'takeaway' } };
export const Busy: Story = { args: { disabled: true } };
