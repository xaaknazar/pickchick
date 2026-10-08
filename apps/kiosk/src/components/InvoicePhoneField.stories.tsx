import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { InvoicePhoneField } from './InvoicePhoneField';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/InvoicePhoneField',
  component: InvoicePhoneField,
  args: { value: '', onChange: fn(), busy: false, locale: 'ru' },
  decorators: [
    (Story) => (
      // Backdrop only: the phone field is drawn for the blue v3 review screen.
      <View style={{ flex: 1, backgroundColor: colors.blue }}>
        <Wrapper padding={28}>
          <Story />
        </Wrapper>
      </View>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof InvoicePhoneField>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Filled: Story = { args: { value: '+7 (700) 000-00-00' } };
export const Sending: Story = { args: { value: '+7 (700) 000-00-00', busy: true } };
export const Kazakh: Story = { args: { locale: 'kk' } };
export const Interactive: Story = {
  render: function Input(args) {
    const [value, setValue] = useState('');
    return <InvoicePhoneField {...args} value={value} onChange={setValue} />;
  },
};
