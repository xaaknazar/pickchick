import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { DeviceField } from './DeviceField';
const meta = {
  title: 'Kiosk/DeviceField',
  component: DeviceField,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { name: 'id', label: 'ID устройства', value: 'story-device', onChange: fn(), busy: false },
  tags: ['autodocs'],
} satisfies Meta<typeof DeviceField>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Secret = {
  args: { name: 'key', label: 'Ключ устройства', value: 'demo-placeholder' },
};
