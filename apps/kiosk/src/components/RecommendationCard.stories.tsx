import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { RecommendationCard } from './RecommendationCard';
const meta = {
  title: 'Kiosk/RecommendationCard',
  component: RecommendationCard,
  decorators: [
    (Story) => (
      <Wrapper padding={28} maxWidth={420}>
        <Story />
      </Wrapper>
    ),
  ],
  args: {
    product: catalog.products.find((p) => p.id === 'toast')!,
    position: 0,
    added: false,
    busy: false,
    locale: 'ru',
    onAdd: fn(),
  },
  tags: ['autodocs'],
} satisfies Meta<typeof RecommendationCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Added: Story = { args: { added: true } };
