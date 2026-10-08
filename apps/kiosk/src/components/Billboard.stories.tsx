import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { Billboard } from './Billboard';
const featured = catalog.products.find((p) => p.name === 'Master Combo') ?? catalog.products[0]!;
const meta = {
  title: 'Kiosk/Billboard',
  component: Billboard,
  decorators: [
    (Story) => (
      <Wrapper padding={28} maxWidth={720}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { product: featured, locale: 'ru', onOpen: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof Billboard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh = { args: { locale: 'kk' } };
