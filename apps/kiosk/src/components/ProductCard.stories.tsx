import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { product } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { ProductCard } from './ProductCard';
const meta = {
  title: 'Kiosk/ProductCard',
  component: ProductCard,
  decorators: [
    (Story) => (
      <Wrapper padding={28} maxWidth={360}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { product, locale: 'ru', onOpen: fn(), onAdd: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Hit: Story = { args: { tag: 'hit' } };
export const New: Story = { args: { tag: 'new', locale: 'kk' } };
export const Recommendation: Story = { args: { variant: 'recommendation' } };
export const SoldOut = { args: { product: { ...product, available: false } } };
export const Loading = { args: { busy: true } };
