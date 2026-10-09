import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { CatalogChangeNotice } from './CatalogChangeNotice';
import { PRICES_UPDATED, MENU_UPDATED } from '../cart-reprice';
const meta = {
  title: 'Mobile/CatalogChangeNotice',
  component: CatalogChangeNotice,
  tags: ['autodocs'],
  args: {
    message: PRICES_UPDATED,
    totals: { oldTotal: '419000', newTotal: '449000' },
    onDismiss: () => {},
  },
} satisfies Meta<typeof CatalogChangeNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UpdatedPrices: Story = {};
export const CompositionChanged: Story = { args: { message: MENU_UPDATED, totals: null } };
export const Checkout: Story = { args: { onDismiss: undefined } };
