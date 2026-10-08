import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ProductActions } from './ProductActions';
const meta = {
  title: 'Kiosk/ProductActions',
  component: ProductActions,
  args: {
    locale: 'ru',
    quantity: 1,
    price: '419000',
    valid: true,
    available: true,
    busy: false,
    next: false,
    requiredValid: true,
    onNext: fn(),
    onMinus: fn(),
    onPlus: fn(),
    onAdd: fn(),
    onAttention: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductActions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** Pale pill: a tap calls `onAttention` (scroll to and shake the missing group). */
export const Required = { args: { valid: false, price: null } };
/** Larger set: the price in the label counts up to the new total. */
export const Quantity = { args: { quantity: 3, price: '1257000' } };
export const Busy = { args: { busy: true } };
export const SetNext = { args: { next: true } };
export const SetNextBlocked = { args: { next: true, requiredValid: false } };
