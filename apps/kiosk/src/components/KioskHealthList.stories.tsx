import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';
import { Wrapper } from './Wrapper';
import { KioskHealthList } from './KioskHealthList';
import { colors } from '../theme';
import { kioskHealthLines, type KioskHealthFacts } from '../kiosk-health';
import { KIOSK_PRODUCTION_API_URL, KIOSK_STAGING_API_URL } from '../api';

// Synthetic facts only: no device id, key or guest data ever reaches the health line.
const now = Date.parse('2026-10-24T09:00:00Z');
const production: KioskHealthFacts = {
  version: '0.1.0',
  build: '24',
  releaseId: 'pk-0123456789abcdef',
  profile: 'production',
  apiOrigin: KIOSK_PRODUCTION_API_URL,
  commercial: true,
  staffCode: 'verified',
  heartbeat: { at: now - 12000, status: 200 },
  checkedAt: now,
};
const meta = {
  title: 'Kiosk/KioskHealthList',
  component: KioskHealthList,
  args: { lines: kioskHealthLines(production, 'ru'), locale: 'ru' },
  decorators: [
    (Story) => (
      // Backdrop only: the list is drawn for the white staff dialog.
      <View style={{ flex: 1, backgroundColor: colors.white }}>
        <Wrapper padding={28} maxWidth={700}>
          <Story />
        </Wrapper>
      </View>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof KioskHealthList>;
export default meta;
type Story = StoryObj<typeof meta>;
/** A pinned production release that reaches the device center. */
export const Production: Story = {};
/** The device center refuses presence (DEVICE_CENTER_ENABLED off or no gateway route). */
export const PresenceRefused: Story = {
  args: {
    lines: kioskHealthLines({ ...production, heartbeat: { at: now - 5000, status: 404 } }, 'ru'),
  },
};
/** No connection for a few minutes. */
export const Offline: Story = {
  args: {
    lines: kioskHealthLines(
      { ...production, heartbeat: { at: now - 3 * 60000, status: null } },
      'kk',
    ),
    locale: 'kk',
  },
};
/** A development build without the commercial flag: every fact needs a look. */
export const Simulator: Story = {
  args: {
    lines: kioskHealthLines(
      {
        ...production,
        releaseId: null,
        profile: 'staging',
        apiOrigin: KIOSK_STAGING_API_URL,
        commercial: false,
        staffCode: 'not-required',
        heartbeat: null,
      },
      'en',
    ),
    locale: 'en',
  },
};
