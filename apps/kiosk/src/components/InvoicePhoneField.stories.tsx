import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { InvoicePhoneField } from './InvoicePhoneField';
const meta = {
  title: 'Kiosk/InvoicePhoneField',
  component: InvoicePhoneField,
  args: { value: '', onChange: fn(), busy: false, locale: 'ru' },
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
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
