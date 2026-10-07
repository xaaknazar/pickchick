import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Body, Wrapper } from './UI';
import { ScrollArea } from './ScrollArea';
const meta = {
  title: 'Kiosk/ScrollArea',
  component: ScrollArea,
  args: {
    children: (
      <Wrapper padding={24} gap={24}>
        {Array.from({ length: 15 }, (_, i) => (
          <Body key={i}>Позиция заказа {i + 1}</Body>
        ))}
      </Wrapper>
    ),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ScrollArea>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
