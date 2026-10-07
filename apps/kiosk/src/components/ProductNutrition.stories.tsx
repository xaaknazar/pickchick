import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { product } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { ProductNutrition } from './ProductNutrition';
const meta = {
  title: 'Kiosk/ProductNutrition',
  component: ProductNutrition,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { product, locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof ProductNutrition>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
