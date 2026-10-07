import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Body, Button } from './UI';
import { Wrapper } from './Wrapper';
const meta = {
  title: 'Kiosk/Wrapper',
  component: Wrapper,
  args: {
    dir: 'row',
    gap: 24,
    padding: 24,
    children: (
      <>
        <Body>Состав заказа</Body>
        <Button label="Дальше" onPress={fn()} />
      </>
    ),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Wrapper>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
