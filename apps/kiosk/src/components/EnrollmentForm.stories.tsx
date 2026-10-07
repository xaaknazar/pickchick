import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { EnrollmentForm } from './EnrollmentForm';
const meta = {
  title: 'Kiosk/EnrollmentForm',
  component: EnrollmentForm,
  args: {
    locale: 'ru',
    onLocale: fn(),
    deviceId: '',
    onDeviceId: fn(),
    deviceKey: '',
    onDeviceKey: fn(),
    busy: false,
    error: false,
    valid: false,
    onSubmit: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof EnrollmentForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Invalid = { args: { error: true } };
