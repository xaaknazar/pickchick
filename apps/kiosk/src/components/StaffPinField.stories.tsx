import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { StaffPinField } from './StaffPinField';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/StaffPinField',
  component: StaffPinField,
  args: { value: '', onChange: fn(), locale: 'ru' },
  decorators: [
    (Story) => (
      // Backdrop only: the field is drawn for the white staff dialog.
      <View style={{ flex: 1, backgroundColor: colors.white }}>
        <Wrapper padding={28} maxWidth={700}>
          <Story />
        </Wrapper>
      </View>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof StaffPinField>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Filled: Story = { args: { value: '4829' } };
export const Wrong: Story = { args: { value: '1111', error: 'wrong' } };
export const Locked: Story = { args: { error: 'locked' } };
/** No KIOSK_STAFF_PIN_VERIFIER on the server (or an old server): staff actions are off. */
export const Unavailable: Story = { args: { error: 'unavailable', locale: 'kk' } };
export const Offline: Story = { args: { error: 'network', locale: 'en' } };
export const Checking: Story = { args: { value: '4829', busy: true } };
export const Interactive: Story = {
  render: function Input(args) {
    const [value, setValue] = useState('');
    return <StaffPinField {...args} value={value} onChange={setValue} />;
  },
};
