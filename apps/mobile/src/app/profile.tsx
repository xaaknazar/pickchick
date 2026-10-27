import { ScreenHost } from '../ScreenHost';

// Owner 27.10.2026: the profile left the tab bar. It opens from the header profile button as
// a stack screen above the tabs (back chevron and native swipe back) at the same URL /profile.
export default function Profile() {
  return <ScreenHost id="M30" />;
}
