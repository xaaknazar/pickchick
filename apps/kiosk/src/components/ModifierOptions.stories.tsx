import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { group, selections } from '../stories/fixtures';
import { Wrapper } from './Wrapper';
import { ModifierOptions } from './ProductOptions';
const meta = {
  title: 'Kiosk/ModifierOptions',
  component: ModifierOptions,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { group, selections, setSelections: fn(), locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof ModifierOptions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
