import type { ScreenProps } from '../model';
import { ConnectedCheckout, ConnectedHistory, ConnectedOrder } from './ConnectedOrderScreens';
import {
  Branches,
  Cart,
  ChangedCart,
  Checkout,
  Combo,
  Menu,
  ProductDetail,
  Unavailable,
  Welcome,
} from './CatalogScreens';
import { Events, Game, GameResult } from './GameScreens';
import {
  History,
  Ledger,
  OrderDetail,
  PaymentStatus,
  Ready,
  Receipt,
  Refund,
  Rewards,
  Tracker,
  Wallet,
} from './OrderScreens';
import {
  DeleteAccount,
  Legal,
  Onboarding,
  Otp,
  Phone,
  Profile,
  Qr,
  Rating,
  Settings,
  Support,
  UnknownScreen,
} from './ProfileScreens';

/** Native counterparts of the canonical design catalog M01–M35. */
export function MobileScreen(props: ScreenProps) {
  if (!props.preview) {
    if (props.screenId === 'M12') return <ConnectedCheckout {...props} />;
    if (props.screenId === 'M19') return <ConnectedHistory {...props} />;
    if (['M13', 'M14', 'M15', 'M16', 'M17', 'M18', 'M20', 'M21', 'M22'].includes(props.screenId))
      return <ConnectedOrder {...props} />;
  }
  switch (props.screenId) {
    case 'M01':
      return <Welcome {...props} />;
    case 'M02':
      return <Phone {...props} />;
    case 'M03':
      return <Otp {...props} />;
    case 'M04':
      return <Onboarding {...props} />;
    case 'M05':
      return <Branches {...props} />;
    case 'M06':
      return <Menu {...props} />;
    case 'M07':
      return <ProductDetail {...props} />;
    case 'M08':
      return <Combo {...props} />;
    case 'M09':
      return <Cart {...props} />;
    case 'M10':
      return <ChangedCart {...props} />;
    case 'M11':
      return <Unavailable {...props} />;
    case 'M12':
      return <Checkout {...props} />;
    case 'M13':
    case 'M14':
    case 'M15':
    case 'M16':
      return <PaymentStatus {...props} />;
    case 'M17':
      return <Tracker {...props} />;
    case 'M18':
      return <Ready {...props} />;
    case 'M19':
      return <History {...props} />;
    case 'M20':
      return <OrderDetail {...props} />;
    case 'M21':
      return <Receipt {...props} />;
    case 'M22':
      return <Refund {...props} />;
    case 'M23':
      return <Wallet {...props} />;
    case 'M24':
      return <Ledger {...props} />;
    case 'M25':
      return <Rewards {...props} />;
    case 'M26':
      return <Events {...props} />;
    case 'M27':
      return <Game {...props} />;
    case 'M28':
      return <GameResult {...props} />;
    case 'M29':
      return <Qr {...props} />;
    case 'M30':
      return <Profile {...props} />;
    case 'M31':
      return <Support {...props} />;
    case 'M32':
      return <DeleteAccount {...props} />;
    case 'M33':
      return <Legal {...props} />;
    case 'M34':
      return <Settings {...props} />;
    case 'M35':
      return <Rating {...props} />;
    default:
      return <UnknownScreen {...props} />;
  }
}
