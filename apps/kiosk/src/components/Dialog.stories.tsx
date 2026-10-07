import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Body, Button, Heading } from './UI';
import { Dialog } from './Dialog';
const meta = {
  title: 'Kiosk/Dialog',
  component: Dialog,
  args: {
    visible: true,
    onClose: fn(),
    children: (
      <>
        <Heading>Продолжить заказ?</Heading>
        <Body>Ваш выбор сохранён.</Body>
      </>
    ),
    footer: <Button label="Продолжить" onPress={fn()} />,
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Sheet = { args: { placement: 'bottom' } };
