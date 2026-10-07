import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Wrapper } from './Wrapper';
import { Notice } from './Notice';
const meta = {
  title: 'Kiosk/Notice',
  component: Notice,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { title: 'Мы рядом', body: 'Пригласите сотрудника ресторана.' },
  tags: ['autodocs'],
} satisfies Meta<typeof Notice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Error = {
  args: { tone: 'error', title: 'Не удалось обновить заказ', body: 'Попробуйте ещё раз.' },
};
