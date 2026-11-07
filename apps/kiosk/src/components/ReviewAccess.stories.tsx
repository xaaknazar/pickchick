import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { fn } from 'storybook/test';
import { ReviewAccess } from './ReviewAccess';
const meta = {
  title: 'Kiosk/ReviewAccess',
  component: ReviewAccess,
  args: { locale: 'en', onOpen: fn() },
  tags: ['autodocs'],
} satisfies Meta<typeof ReviewAccess>;
export default meta;
type Story = StoryObj<typeof meta>;
// Visible only in a review-enabled build; no default review credential is shipped.
export const Default: Story = {};
