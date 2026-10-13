import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { Wrapper } from './Wrapper';
import { KaspiAmount } from './KaspiAmount';
const meta = {
  title: 'Kiosk/Redesign/KaspiAmount',
  component: KaspiAmount,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Wrapper flex={1} align="center" justify="center">
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: { total: '577000', locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof KaspiAmount>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
/** A long amount shrinks to fit instead of wrapping. */
export const LargeAmount: Story = { args: { total: '12345600' } };
export const Kazakh: Story = { args: { locale: 'kk' } };
export const English: Story = { args: { locale: 'en' } };
