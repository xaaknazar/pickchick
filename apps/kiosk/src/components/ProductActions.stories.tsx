import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ProductActions } from './ProductActions';
const meta = {
  title: 'Kiosk/ProductActions',
  component: ProductActions,
  args: {
    locale: 'ru',
    quantity: 1,
    price: '2 990 ₸',
    valid: true,
    available: true,
    busy: false,
    next: false,
    requiredValid: true,
    onNext: fn(),
    onMinus: fn(),
    onPlus: fn(),
    onAdd: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductActions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Required = { args: { valid: false, price: null } };
