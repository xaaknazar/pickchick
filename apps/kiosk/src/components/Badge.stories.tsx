import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { Wrapper } from './Wrapper';
import { Badge } from './Badge';
const meta = {
  title: 'Kiosk/Redesign/Badge',
  component: Badge,
  decorators: [
    (Story) => (
      <Wrapper padding={28}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { label: 'ХИТ' },
  tags: ['autodocs'],
} satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Card badge «ХИТ»: the red gradient, turned -2deg. */
export const Hit: Story = {};
/** Card badges «НОВИНКА», «ОСТРОЕ», «СВОЙ РЕЦЕПТ»: brand blue. */
export const New: Story = { args: { label: 'НОВИНКА', tone: 'new' } };
/** The hit tile's label. */
export const HitTag: Story = { args: { label: 'ХИТ НЕДЕЛИ', shape: 'tag' } };
export const KazakhTag: Story = { args: { label: 'СҮЙІКТІ ҚОСЫМША', shape: 'tag' } };
