import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { product } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { ProductIntro } from './ProductIntro';
const meta = {
  title: 'Kiosk/ProductIntro',
  component: ProductIntro,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { product, locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductIntro>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
