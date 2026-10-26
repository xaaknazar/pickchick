import { copy, type Locale } from './i18n.ts';
import type { KioskBuildProfile } from './api.ts';

/**
 * Staff-only kiosk health line (stage 2, lane kln): what an installer or manager needs to confirm
 * on the iPad itself - which build runs, which API it talks to, whether it is the commercial
 * build, whether the server accepted the staff code and when device presence last reached the
 * server. It never carries device credentials, guest data or the staff code.
 */

/** Outcome of the last device presence request; `status` null means no HTTP answer. */
export interface KioskHeartbeat {
  at: number;
  status: number | null;
}
export interface KioskHealthFacts {
  version: string;
  build: string;
  /** Release id pinned by scripts/mobile/ios_release.py; null in development builds. */
  releaseId: string | null;
  profile: KioskBuildProfile;
  apiOrigin: string;
  /** EXPO_PUBLIC_KIOSK_COMMERCIAL=1: the guest checkout with real payments. */
  commercial: boolean;
  /** `verified`: the server has just accepted the staff code; the simulator has none. */
  staffCode: 'verified' | 'not-required';
  /** Presence runs only in the commercial build; null there until the first attempt ends. */
  heartbeat: KioskHeartbeat | null;
  checkedAt: number;
}
export type KioskHealthId = 'build' | 'api' | 'commercial' | 'staff' | 'heartbeat';
export interface KioskHealthLine {
  id: KioskHealthId;
  label: string;
  value: string;
  /** Not what a restaurant iPad in production should show: staff checks it. */
  attention: boolean;
}
/** Presence is sent every 15 s while active; four missed rounds need a look. */
export const KIOSK_HEARTBEAT_STALE_MS = 60000;

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

function age(ms: number, locale: Locale) {
  const t = copy(locale);
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return fill(t.healthAgeSeconds, { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return fill(t.healthAgeMinutes, { n: minutes });
  return fill(t.healthAgeHours, { n: Math.round(minutes / 60) });
}

export function kioskHealthLines(facts: KioskHealthFacts, locale: Locale): KioskHealthLine[] {
  const t = copy(locale);
  const beat = facts.heartbeat;
  const heartbeat: Pick<KioskHealthLine, 'value' | 'attention'> = !facts.commercial
    ? { value: t.healthHeartbeatOff, attention: true }
    : !beat
      ? { value: t.healthHeartbeatNone, attention: true }
      : {
          value:
            beat.status === null
              ? fill(t.healthHeartbeatOffline, { age: age(facts.checkedAt - beat.at, locale) })
              : beat.status >= 200 && beat.status < 300
                ? fill(t.healthHeartbeatOk, { age: age(facts.checkedAt - beat.at, locale) })
                : fill(t.healthHeartbeatStatus, {
                    age: age(facts.checkedAt - beat.at, locale),
                    status: beat.status,
                  }),
          attention:
            beat.status === null ||
            beat.status < 200 ||
            beat.status >= 300 ||
            facts.checkedAt - beat.at > KIOSK_HEARTBEAT_STALE_MS,
        };
  return [
    {
      id: 'build',
      label: t.healthBuild,
      value: facts.releaseId
        ? fill(t.healthBuildRelease, {
            version: facts.version,
            build: facts.build,
            release: facts.releaseId,
          })
        : fill(t.healthBuildDev, { version: facts.version, build: facts.build }),
      attention: !facts.releaseId,
    },
    {
      id: 'api',
      label: t.healthApi,
      value: `${facts.apiOrigin} (${facts.profile})`,
      attention: facts.profile !== 'production',
    },
    {
      id: 'commercial',
      label: t.healthCommercial,
      value: facts.commercial ? t.healthOn : t.healthOff,
      attention: !facts.commercial,
    },
    {
      id: 'staff',
      label: t.healthStaff,
      value: facts.staffCode === 'verified' ? t.healthStaffVerified : t.healthStaffNone,
      attention: facts.staffCode !== 'verified',
    },
    { id: 'heartbeat', label: t.healthHeartbeat, ...heartbeat },
  ];
}

/**
 * Opens the health line behind the staff code: with a server check (the commercial kiosk) a
 * refused or unchecked code shows nothing and reads no facts; the simulator build has no staff
 * code and shows them at once.
 */
export async function openKioskHealth(
  io: { verifyStaff?: (pin: string) => Promise<boolean>; facts: () => KioskHealthFacts },
  pin?: string,
): Promise<KioskHealthFacts | null> {
  if (io.verifyStaff && !(await io.verifyStaff(pin ?? ''))) return null;
  return io.facts();
}
