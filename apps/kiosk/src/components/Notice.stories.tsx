import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { Wrapper } from './Wrapper';
import { Notice } from './Notice';
const meta = {
  title: 'Kiosk/Notice',
  component: Notice,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <Wrapper padding={28}>
          <Story />
        </Wrapper>
      </ScreenSurface>
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
export const ErrorOnly = {
  args: { tone: 'error', title: undefined, body: 'Не удалось обновить заказ. Попробуйте ещё раз.' },
};
