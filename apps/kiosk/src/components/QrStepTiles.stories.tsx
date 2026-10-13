import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { ScreenSurface } from './ScreenSurface';
import { RadialBackdrop } from './RadialBackdrop';
import { Wrapper } from './Wrapper';
import { QrStepTiles } from './QrStepTiles';
const meta = {
  title: 'Kiosk/Redesign/QrStepTiles',
  component: QrStepTiles,
  decorators: [
    (Story) => (
      <ScreenSurface tone="brand">
        <RadialBackdrop />
        <Wrapper flex={1} paddingX={16} justify="center">
          <Story />
        </Wrapper>
      </ScreenSurface>
    ),
  ],
  args: { locale: 'ru' },
  tags: ['autodocs'],
} satisfies Meta<typeof QrStepTiles>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Kazakh: Story = { args: { locale: 'kk' } };
export const English: Story = { args: { locale: 'en' } };
