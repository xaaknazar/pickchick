import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Button } from './UI';
import { Footer } from './Footer';
const meta = {
  title: 'Kiosk/Footer',
  component: Footer,
  args: { children: <Button label="Перейти к оплате" onPress={fn()} /> },
  tags: ['autodocs'],
} satisfies Meta<typeof Footer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
