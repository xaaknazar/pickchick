import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { fn } from 'storybook/test';
import { catalog } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { RecommendationCard } from './RecommendationCard';
import { colors } from '../theme';
const meta = {
  title: 'Kiosk/RecommendationCard',
  component: RecommendationCard,
  decorators: [
    (Story) => (
      // Backdrop only: upsell cards sit on the blue v3 surface.
      <View style={{ flex: 1, backgroundColor: colors.blue }}>
        <Wrapper padding={28} maxWidth={420}>
          <Story />
        </Wrapper>
      </View>
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
export const Busy: Story = { args: { busy: true } };
/** Tap to toggle: the card pulses, the + spins a turn into a green check. */
export const Toggle: Story = {
  render: function ToggleStory(args) {
    const [added, setAdded] = useState(false);
    return <RecommendationCard {...args} added={added} onAdd={() => setAdded((a) => !a)} />;
  },
};
