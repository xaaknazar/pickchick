import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { redesign } from '../theme';
import { ReviewDining } from './ReviewDining';
const meta = {
  title: 'Kiosk/ReviewDining',
  component: ReviewDining,
  decorators: [
    (Story) => (
      // Backdrop only: the dining choice sits on the blue payment page.
      <View style={{ padding: 28, backgroundColor: redesign.screen[1] }}>
        <Story />
      </View>
    ),
  ],
  args: { mode: 'dine_in', locale: 'ru', onChange: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof ReviewDining>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DineIn: Story = {};
export const Takeaway: Story = { args: { mode: 'takeaway' } };
export const Kazakh: Story = { args: { locale: 'kk' } };
export const English: Story = { args: { locale: 'en', mode: 'takeaway' } };
export const Busy: Story = { args: { disabled: true } };
