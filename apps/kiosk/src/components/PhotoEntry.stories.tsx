import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { Wrapper } from './Wrapper';
import { PhotoEntry } from './PhotoEntry';
const meta = {
  title: 'Kiosk/PhotoEntry',
  component: PhotoEntry,
  decorators: [
    (Story) => (
      <Wrapper width={170}>
        <Story />
      </Wrapper>
    ),
  ],
  args: { locale: 'ru', onInteraction: fn() },
} satisfies Meta<typeof PhotoEntry>;
export default meta;
export const Default: StoryObj<typeof meta> = {};

export const Kazakh: StoryObj<typeof meta> = { args: { locale: 'kk' } };
export const English: StoryObj<typeof meta> = { args: { locale: 'en' } };
export const Disabled: StoryObj<typeof meta> = { args: { disabled: true } };
