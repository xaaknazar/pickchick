import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { Language } from './Language';
const meta = {
  title: 'Kiosk/Language',
  component: Language,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { locale: 'ru', onChange: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof Language>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh = { args: { locale: 'kk' } };
