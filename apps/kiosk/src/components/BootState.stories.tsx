import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { BootState } from './BootState';
const meta = {
  title: 'Kiosk/BootState',
  component: BootState,
  args: { title: 'Загружаем меню' },
  tags: ['autodocs'],
} satisfies Meta<typeof BootState>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Failure = {
  args: { loading: false, title: 'Не удалось загрузить меню', onRetry: fn() },
};
