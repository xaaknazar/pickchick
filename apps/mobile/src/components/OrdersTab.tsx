import { t, localize, useLocale } from '../i18n';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AppState,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import type { Product } from '../model';
import type { OrderScene } from '../order-status';
import { invoiceSecondsRemaining } from '../commerce-presentation';
import { money } from '../domain';
import { menuPhotos } from '../menu-photo-assets';
import {
  activeSectionTitle,
  countdownLabel,
  groupByAlmatyDay,
  historyMetaParts,
  itemsSummary,
  photoTileLayout,
  serviceLabel,
  sortActive,
  type ActiveKind,
  type OrderLineView,
  type PhotoCell,
} from '../orders-tab';
import { colors, font } from '../theme';
import { MotionPressable } from './Motion';
import { ProductPhoto, productPhoto } from './ProductPhoto';
import { AppHeader } from './AppHeader';
import { Button, Icon } from './UI';

/** Orders-tab colours from the approved brief (2026-10-12) that the theme does not name yet. */
export const ordersPalette = {
  accentSoft: 'rgba(255,105,0,0.16)',
  readySurface: '#0E3A3A',
  readyBorder: '#2F7A62',
  readyTile: 'rgba(47,122,98,0.25)',
  readyBadgeText: '#0B3B2A',
  cancelled: '#FFB3C6',
  photo: '#F7F3EC',
};

// Same supplied scenes as the tracker (OrderChef); static here, no crossfade in a list.
const chefScenes: Record<OrderScene, number> = {
  cooking: require('../../assets/order-status/chef-cooking.png'),
  assembly: require('../../assets/order-status/chef-assembly.png'),
  ready: require('../../assets/order-status/chef-ready.png'),
  'ready-takeaway': require('../../assets/order-status/chef-ready-takeaway.png'),
};

/** Short phones (iPhone SE class): the shared header leaves less room for the tab content. */
const compactHeight = 700;

export function OrdersHeader() {
  useLocale();
  const { height } = useWindowDimensions();
  const compact = height < compactHeight;
  // Owner 27.10.2026: the shared top header (logo, restaurant, profile) above the tab title.
  // Page already pads the safe area; the logo now lives in the header row, which keeps the
  // same gutter and width on every tab, so the profile button does not shift between tabs.
  return (
    <View>
      <AppHeader safeArea={false} />
      <View style={[s.header, compact && s.headerCompact]}>
        <Text
          accessibilityRole="header"
          style={[s.title, compact && s.titleCompact]}
          testID="orders-title"
        >
          {t('Заказы')}
        </Text>
      </View>
    </View>
  );
}

export function OrdersSectionLabel({ children, testID }: { children: string; testID?: string }) {
  useLocale();
  return (
    <Text accessibilityRole="header" style={s.sectionLabel} testID={testID}>
      {localize(children)}
    </Text>
  );
}

type TileSource =
  | { kind: 'photo'; photo: ReturnType<typeof productPhoto> }
  | { kind: 'image'; image: ImageSourcePropType }
  | null;
// Catalog photo by productId, else the bundled menu photo, as the history card always did.
function photoSource(productId: string, products: readonly Product[]): TileSource {
  const product = products.find((entry) => entry.id === productId);
  if (product) return { kind: 'photo', photo: productPhoto(product, 'thumb', 'menu') };
  const image = menuPhotos[productId];
  return image ? { kind: 'image', image } : null;
}

function PhotoCellView({
  cell,
  products,
  style,
}: {
  cell: PhotoCell;
  products: readonly Product[];
  style: StyleProp<ViewStyle>;
}) {
  useLocale();
  if (cell.kind === 'more')
    return (
      <View style={[style, s.cellMore]}>
        <Text style={s.cellMoreText}>+{localize(cell.count)}</Text>
      </View>
    );
  if (cell.kind === 'empty') return <View style={[style, s.cellEmpty]} />;
  const source = photoSource(cell.productId, products);
  return (
    <View style={[style, s.cellPhoto]}>
      {source?.kind === 'photo' ? (
        <ProductPhoto photo={source.photo} contentFit="cover" style={s.fill} />
      ) : source ? (
        <Image source={source.image} contentFit="cover" style={s.fill} />
      ) : (
        <Icon name="restaurant-outline" color={colors.background} size={20} />
      )}
    </View>
  );
}

/** 56×56 tile: one photo, two halves, or a 2×2 grid with «+N». */
export function OrderPhotoTile({
  productIds,
  products,
  muted = false,
  size = 56,
  testID,
}: {
  productIds: readonly string[];
  products: readonly Product[];
  muted?: boolean;
  size?: number;
  testID?: string;
}) {
  useLocale();
  const layout = photoTileLayout(productIds);
  const gap = 2;
  const half = (size - gap) / 2;
  const cellStyle =
    layout.shape === 'single'
      ? { width: size, height: size }
      : layout.shape === 'halves'
        ? { width: half, height: size }
        : { width: half, height: half };
  return (
    <View
      testID={testID}
      style={[
        s.tile,
        { width: size, height: size, borderRadius: size >= 56 ? 14 : 12 },
        muted && s.muted,
      ]}
    >
      {layout.cells.map((cell, index) => (
        <PhotoCellView key={index} cell={cell} products={products} style={cellStyle} />
      ))}
    </View>
  );
}

export interface ActiveOrderModel {
  id: string;
  kind: ActiveKind;
  number: string | null;
  scene: OrderScene;
  badge: string;
  /** Lit stage bars of «Кухня / Сборка / Выдача». */
  bars: number;
  serviceMode: 'takeaway' | 'dine_in';
  items: OrderLineView[];
  totalMinor: string;
  /** «ТЦ Abay Plaza · Kaspi». */
  place: string;
  /** Payment variant: «Kaspi» or «Банковская карта». */
  paymentMethod?: string;
  /** Payment variant without a running invoice countdown. */
  paymentNote?: string;
  /** Kaspi invoice deadline; the only source of the countdown. */
  expiresAt?: string | null;
  /** Remaining minutes from a real estimate. Nothing is shown without one. */
  etaMinutes?: number | null;
  testID?: string;
  openTestID: string;
  onOpen(): void;
  /** Existing payment continuation; absent when payment cannot continue from here. */
  onPay?: () => void;
  payTestID?: string;
}

function useInvoiceRemaining(expiresAt: string | null | undefined) {
  const [now, setNow] = useState(Date.now);
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const remaining = invoiceSecondsRemaining(expiresAt ?? null, now);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => listener.remove();
  }, []);
  // Presentation clock only; the bank stays the payment authority.
  useEffect(() => {
    if (!expiresAt || !foreground) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, foreground]);
  return remaining;
}

function StageBars({ bars }: { bars: number }) {
  useLocale();
  return (
    <View style={s.bars} accessible={false}>
      {['Кухня', 'Сборка', 'Выдача'].map((label, index) => (
        <View key={label} style={s.barItem}>
          <View style={[s.bar, index < bars && s.barActive]} />
          <Text style={[s.barLabel, index === bars - 1 && s.barLabelActive]} numberOfLines={1}>
            {localize(label)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Badge({ kind, children }: { kind: ActiveKind; children: string }) {
  useLocale();
  return (
    <View
      style={[
        s.badge,
        kind === 'ready' ? s.badgeReady : kind === 'payment' ? s.badgePayment : s.badgeProgress,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          s.badgeText,
          kind === 'ready'
            ? { color: ordersPalette.readyBadgeText }
            : kind === 'payment'
              ? { color: colors.warning }
              : { color: colors.accentText },
        ]}
      >
        {localize(children)}
      </Text>
    </View>
  );
}

// Jost has no «№» glyph (web falls back to a serif), so the sign is set in Manrope.
function OrderNumber({ number, style }: { number: string | null; style: StyleProp<TextStyle> }) {
  useLocale();
  return (
    <Text style={style} numberOfLines={1}>
      {localize(
        number ? (
          <>
            <Text style={s.numberSign}>№</Text> {number}
          </>
        ) : (
          'Заказ'
        ),
      )}
    </Text>
  );
}

export function ActiveOrderCard({
  model,
  products,
}: {
  model: ActiveOrderModel;
  products: readonly Product[];
}) {
  useLocale();
  const remaining = useInvoiceRemaining(model.kind === 'payment' ? model.expiresAt : null);
  const summary = itemsSummary(model.items);
  // Every part in the app language (review 29.10.2026: EN read «Order number 15, Готов»).
  const label = `${model.number ? t('Заказ номер {p0}', { p0: model.number }) : t('Заказ')}, ${t(model.badge)}, ${serviceLabel(model.serviceMode)}, ${summary}, ${money(model.totalMinor)}`;
  if (model.kind === 'payment') {
    const note =
      remaining !== null && remaining > 0
        ? t('осталось {p0}', { p0: countdownLabel(remaining) })
        : remaining === 0
          ? 'проверяем счёт'
          : model.paymentNote;
    const line = [model.paymentMethod, note].filter(Boolean).join(' · ');
    return (
      <View style={s.card} testID={model.testID}>
        <MotionPressable
          testID={model.openTestID}
          accessibilityRole="button"
          accessibilityLabel={localize(t('{p0}. Открыть заказ', { p0: label }))}
          onPress={model.onOpen}
          style={s.payTop}
        >
          <OrderPhotoTile
            productIds={model.items.map((item) => item.productId)}
            products={products}
            size={44}
          />
          <View style={s.flex}>
            <View style={s.numberRow}>
              <OrderNumber number={model.number} style={s.payNumber} />
              <Badge kind="payment">{model.badge}</Badge>
            </View>
            {line ? (
              <Text
                style={s.line}
                numberOfLines={2}
                testID={
                  remaining !== null && remaining > 0 ? `${model.openTestID}-countdown` : undefined
                }
              >
                {localize(line)}
              </Text>
            ) : null}
          </View>
          <Text style={s.amount}>{localize(money(model.totalMinor))}</Text>
        </MotionPressable>
        {model.onPay ? (
          <Button
            title={t('Перейти к оплате')}
            testID={model.payTestID}
            onPress={model.onPay}
            style={s.payButton}
            textStyle={s.payButtonText}
          />
        ) : null}
      </View>
    );
  }
  const ready = model.kind === 'ready';
  return (
    <View testID={model.testID}>
      <MotionPressable
        testID={model.openTestID}
        accessibilityRole="button"
        accessibilityLabel={localize(t('{p0}. Открыть статус заказа', { p0: label }))}
        onPress={model.onOpen}
        style={[s.card, ready && s.cardReady]}
      >
        <View style={s.cardTop}>
          <View style={[s.chefTile, ready && { backgroundColor: ordersPalette.readyTile }]}>
            <Image
              source={chefScenes[model.scene]}
              contentFit="cover"
              style={s.fill}
              testID={`orders-active-chef-${model.scene}`}
            />
          </View>
          <View style={s.flex}>
            <View style={s.numberRow}>
              <OrderNumber number={model.number} style={ready ? s.readyNumber : s.number} />
              <Badge kind={model.kind}>{model.badge}</Badge>
            </View>
            {ready ? (
              <Text style={s.readyCaption}>{t('Покажите номер на выдаче')}</Text>
            ) : (
              <Text style={s.line} numberOfLines={2}>
                {localize([serviceLabel(model.serviceMode), summary].filter(Boolean).join(' · '))}
              </Text>
            )}
          </View>
          {ready ? (
            <View style={s.chevronTop}>
              <Icon name="chevron-forward" size={20} color={colors.text} />
            </View>
          ) : model.etaMinutes != null && model.etaMinutes > 0 ? (
            <View style={s.eta} testID={`${model.openTestID}-eta`}>
              <Text style={s.etaValue}>~{localize(model.etaMinutes)}</Text>
              <Text style={s.etaUnit}>{t('мин')}</Text>
            </View>
          ) : null}
        </View>
        {ready ? null : <StageBars bars={model.bars} />}
        <View style={[s.divider, ready && { backgroundColor: ordersPalette.readyBorder }]} />
        <View style={s.cardBottom}>
          <Text style={[s.place, ready && s.readyPlace]} numberOfLines={1}>
            {localize(
              ready
                ? [serviceLabel(model.serviceMode), summary].filter(Boolean).join(' · ')
                : model.place,
            )}
          </Text>
          <Text style={s.amount}>{localize(money(model.totalMinor))}</Text>
          {ready ? null : <Icon name="chevron-forward" size={18} color={colors.muted} />}
        </View>
      </MotionPressable>
    </View>
  );
}

export interface HistoryOrderModel {
  id: string;
  number: string | null;
  createdAt: string;
  serviceMode: 'takeaway' | 'dine_in';
  items: OrderLineView[];
  totalMinor: string;
  /** done: handed over; cancelled: muted with a struck amount; note: status text only. */
  status: 'done' | 'cancelled' | 'note';
  statusText?: string;
  rating?: number | null;
  testID?: string;
  openTestID: string;
  openLabel?: string;
  onOpen(): void;
  /** Existing repeat flow trigger, shown on the second line. */
  repeat?: ReactNode;
  /** Star row «Как вам заказ?»; set only on the newest unrated handed-over order. */
  rate?: { onRate(stars: number): void; testID(stars: number): string } | null;
}

export function RateOrderRow({
  onRate,
  testID,
}: {
  onRate(stars: number): void;
  testID(stars: number): string;
}) {
  useLocale();
  return (
    <View style={s.rate} testID="orders-rate-row">
      <Text style={s.rateLabel}>{t('Как вам заказ?')}</Text>
      <View style={s.stars}>
        {[1, 2, 3, 4, 5].map((stars) => (
          <MotionPressable
            key={stars}
            accessibilityRole="button"
            accessibilityLabel={localize(t('Оценить заказ на {p0} из 5', { p0: stars }))}
            onPress={() => onRate(stars)}
            testID={testID(stars)}
            style={s.star}
          >
            <Icon name="star-outline" size={22} color={colors.muted} />
          </MotionPressable>
        ))}
      </View>
    </View>
  );
}

export function HistoryOrderRow({
  model,
  products,
  first,
}: {
  model: HistoryOrderModel;
  products: readonly Product[];
  first: boolean;
}) {
  useLocale();
  const cancelled = model.status === 'cancelled';
  const meta = cancelled
    ? historyMetaParts(model).slice(0, model.number ? 2 : 1)
    : historyMetaParts(model);
  const title = itemsSummary(model.items) || t('Заказ');
  const status = model.statusText
    ? t(model.statusText)
    : model.rating
      ? t('оценка {p0} из 5', { p0: model.rating })
      : '';
  return (
    <View style={[s.row, !first && s.rowDivider]} testID={model.testID}>
      <View style={s.rowBody}>
        {/* The row background is the open-order button; repeat stays a separate button. */}
        <MotionPressable
          testID={model.openTestID}
          accessibilityRole="button"
          accessibilityLabel={localize(
            `${model.number ? t('Заказ номер {p0}', { p0: model.number }) : t('Заказ')}, ${title}, ${money(model.totalMinor)}${status ? `, ${status}` : ''}. ${t(model.openLabel ?? 'Открыть заказ')}`,
          )}
          onPress={model.onOpen}
          style={({ pressed }) => [StyleSheet.absoluteFill, pressed && s.rowPressed]}
        />
        <View style={s.rowContent} pointerEvents="box-none">
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <OrderPhotoTile
              productIds={model.items.map((item) => item.productId)}
              products={products}
              muted={cancelled}
            />
          </View>
          <View style={s.rowText} pointerEvents="box-none">
            <View
              style={s.rowTop}
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={[s.rowTitle, cancelled && s.mutedText]} numberOfLines={2}>
                {localize(title)}
              </Text>
              <Text style={[s.rowAmount, cancelled && s.struck]}>
                {localize(money(model.totalMinor))}
              </Text>
            </View>
            <View style={s.rowMeta} pointerEvents="box-none">
              <View
                style={s.flex}
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Text style={s.metaText} numberOfLines={2}>
                  {localize(meta.join(' · '))}
                  {localize(
                    model.statusText ? (
                      <>
                        {meta.length ? ' · ' : ''}
                        <Text style={cancelled ? s.cancelledText : s.noteText}>
                          {localize(model.statusText)}
                        </Text>
                      </>
                    ) : model.rating ? (
                      <>
                        {' · '}
                        <Text style={s.ratingText}>★ {localize(model.rating)}</Text>
                      </>
                    ) : null,
                  )}
                </Text>
              </View>
              {model.repeat && !cancelled ? model.repeat : null}
            </View>
          </View>
        </View>
      </View>
      {model.rate ? <RateOrderRow onRate={model.rate.onRate} testID={model.rate.testID} /> : null}
    </View>
  );
}

/** Text trigger «↻ Повторить» for the existing repeat flow. */
export function RepeatLink({
  onPress,
  testID,
  number,
}: {
  onPress(): void;
  testID?: string;
  number: string;
}) {
  useLocale();
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={localize(t('Повторить заказ {p0}', { p0: number }))}
      testID={testID}
      onPress={onPress}
      style={s.repeat}
    >
      <Icon name="sync-outline" size={16} color={colors.accentText} />
      <Text style={s.repeatText}>{t('Повторить')}</Text>
    </MotionPressable>
  );
}

export function OrdersOverview({
  active,
  history,
  products,
  footer,
  now = Date.now(),
}: {
  active: ActiveOrderModel[];
  history: HistoryOrderModel[];
  products: readonly Product[];
  footer?: ReactNode;
  now?: number;
}) {
  useLocale();
  const days = groupByAlmatyDay(history, (order) => order.createdAt, now);
  return (
    <View style={s.overview}>
      {active.length ? (
        <View style={s.section} testID="orders-active">
          <OrdersSectionLabel testID="orders-active-title">
            {activeSectionTitle(active.length)}
          </OrdersSectionLabel>
          {sortActive(active).map((model) => (
            <ActiveOrderCard key={model.id} model={model} products={products} />
          ))}
        </View>
      ) : null}
      {days.length ? (
        <View style={s.history} testID="orders-history">
          {active.length ? <OrdersSectionLabel>{t('История')}</OrdersSectionLabel> : null}
          {days.map((day) => (
            <View key={day.key} style={s.day} testID={`orders-day-${day.key}`}>
              <Text style={s.dayLabel} accessibilityRole="header">
                {localize(day.label)}
              </Text>
              <View style={s.dayBlock}>
                {day.items.map((model, index) => (
                  <HistoryOrderRow
                    key={model.id}
                    model={model}
                    products={products}
                    first={index === 0}
                  />
                ))}
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {footer}
    </View>
  );
}

export function OrdersMoreButton({
  title,
  onPress,
  disabled,
  testID,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  testID?: string;
}) {
  useLocale();
  return (
    <Button
      secondary
      title={localize(title)}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={s.more}
      textStyle={s.moreText}
    />
  );
}

export function OrdersEmpty({ onMenu }: { onMenu(): void }) {
  useLocale();
  const [width, setWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  // Short phones: a smaller chef and title keep «Открыть меню» above the tab bar on first view
  // under the shared header (27.10.2026).
  const compact = useWindowDimensions().height < compactHeight;
  const art = Math.min(compact ? 120 : 192, Math.max(compact ? 96 : 132, width * 0.55 || 192));
  return (
    <View style={s.empty} testID="orders-empty" onLayout={onLayout}>
      <View
        style={{ width: art, height: art }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View
          style={[
            s.emptyCircle,
            {
              width: art * 0.78,
              height: art * 0.78,
              borderRadius: art * 0.39,
              left: art * 0.11,
              top: art * 0.11,
            },
          ]}
        />
        <Image
          source={chefScenes.cooking}
          contentFit="contain"
          style={s.fill}
          testID="orders-empty-chef"
        />
      </View>
      <Text accessibilityRole="header" style={[s.emptyTitle, compact && s.emptyTitleCompact]}>
        {t('Фритюр уже горячий')}
      </Text>
      <Text style={s.emptyDetail}>
        {t('Сделайте первый заказ - здесь появится номер, статус готовки и кнопка «Повторить».')}
      </Text>
      <Button
        title={t('Открыть меню')}
        testID="orders-open-menu"
        onPress={onMenu}
        style={[s.emptyButton, compact && s.emptyButtonCompact]}
        textStyle={s.emptyButtonText}
      />
      <View style={s.steps}>
        {['Выберите и оплатите', 'Следите, как готовим', 'Заберите по номеру'].map(
          (step, index) => (
            <View key={step} style={s.step}>
              <View style={s.stepNumber}>
                <Text style={s.stepNumberText}>{localize(index + 1)}</Text>
              </View>
              <Text style={s.stepText}>{localize(step)}</Text>
            </View>
          ),
        )}
      </View>
    </View>
  );
}

export const ordersPageStyle = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 20, paddingTop: 4 },
});

const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  fill: { width: '100%', height: '100%' },
  muted: { opacity: 0.5 },
  header: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 12,
  },
  headerCompact: { paddingBottom: 8 },
  title: {
    flex: 1,
    fontFamily: font.display,
    fontSize: 32,
    lineHeight: 40,
    letterSpacing: -0.4,
    color: colors.text,
  },
  titleCompact: { fontSize: 28, lineHeight: 34 },
  sectionLabel: {
    fontFamily: font.bold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.96,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  overview: { gap: 24 },
  section: { gap: 12 },
  history: { gap: 14 },
  day: { gap: 8 },
  dayLabel: { fontFamily: font.body, fontSize: 15, lineHeight: 20, color: colors.muted },
  dayBlock: { backgroundColor: colors.surface, borderRadius: 20, overflow: 'hidden' },
  tile: {
    overflow: 'hidden',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    backgroundColor: colors.raised,
  },
  cellPhoto: {
    backgroundColor: ordersPalette.photo,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  cellEmpty: { backgroundColor: colors.raised },
  cellMore: { backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center' },
  cellMoreText: { fontFamily: font.bold, fontSize: 14, lineHeight: 18, color: colors.text },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 22,
    padding: 14,
    gap: 12,
  },
  cardReady: {
    backgroundColor: ordersPalette.readySurface,
    borderColor: ordersPalette.readyBorder,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chefTile: {
    width: 64,
    height: 64,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.raised,
  },
  numberRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 10 },
  numberSign: { fontFamily: font.bold },
  number: {
    fontFamily: font.heading,
    fontSize: 22,
    lineHeight: 28,
    color: colors.text,
    flexShrink: 1,
  },
  readyNumber: {
    fontFamily: font.display,
    fontSize: 30,
    lineHeight: 36,
    color: colors.text,
    flexShrink: 1,
  },
  payNumber: {
    fontFamily: font.heading,
    fontSize: 20,
    lineHeight: 26,
    color: colors.text,
    flexShrink: 1,
  },
  badge: { borderRadius: 10, paddingHorizontal: 9, paddingVertical: 3, flexShrink: 1 },
  badgeProgress: { backgroundColor: ordersPalette.accentSoft },
  badgeReady: { backgroundColor: colors.success },
  badgePayment: { backgroundColor: colors.warningSurface },
  badgeText: { fontFamily: font.bold, fontSize: 13, lineHeight: 18 },
  line: { fontFamily: font.body, fontSize: 14, lineHeight: 18, color: colors.muted },
  readyCaption: {
    fontFamily: font.body,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
    marginTop: 2,
  },
  chevronTop: { alignSelf: 'flex-start', paddingTop: 22 },
  eta: { alignItems: 'center', minWidth: 40 },
  etaValue: { fontFamily: font.display, fontSize: 26, lineHeight: 30, color: colors.text },
  etaUnit: { fontFamily: font.body, fontSize: 12, lineHeight: 16, color: colors.muted },
  bars: { flexDirection: 'row', gap: 6 },
  barItem: { flex: 1, gap: 8 },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.border },
  barActive: { backgroundColor: colors.accent },
  barLabel: { fontFamily: font.body, fontSize: 12.5, lineHeight: 16, color: colors.muted },
  barLabelActive: { fontFamily: font.medium, color: colors.text },
  divider: { height: 1, backgroundColor: colors.border },
  cardBottom: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  place: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.body,
    fontSize: 15,
    lineHeight: 20,
    color: colors.muted,
  },
  readyPlace: { color: colors.text, opacity: 0.85 },
  amount: {
    fontFamily: font.bold,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  payTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  payButton: { minHeight: 44, borderRadius: 14, paddingVertical: 10 },
  payButtonText: { fontFamily: font.bold, fontSize: 16, lineHeight: 22 },
  row: {},
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  rowBody: { paddingHorizontal: 14, paddingVertical: 12 },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.04)' },
  rowContent: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowText: { flex: 1, minWidth: 0, gap: 6 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
  },
  rowAmount: {
    fontFamily: font.bold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  mutedText: { color: colors.muted },
  struck: { color: colors.muted, textDecorationLine: 'line-through' },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 },
  metaText: { fontFamily: font.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  ratingText: { color: colors.accentText },
  cancelledText: { color: ordersPalette.cancelled },
  noteText: { color: colors.warning },
  repeat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 44,
    marginVertical: -12,
    paddingLeft: 6,
  },
  repeatText: { fontFamily: font.medium, fontSize: 14, lineHeight: 19, color: colors.accentText },
  rate: {
    marginHorizontal: 14,
    marginBottom: 12,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: 14,
    backgroundColor: colors.raised,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 46,
  },
  rateLabel: {
    flexShrink: 1,
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 19,
    color: colors.text,
    paddingVertical: 12,
    marginRight: 4,
  },
  stars: { flexDirection: 'row', marginLeft: 'auto' },
  // 44pt targets on a 40pt rhythm: neighbours overlap by 4pt instead of shrinking.
  star: {
    width: 44,
    height: 46,
    marginHorizontal: -2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  more: {
    minHeight: 54,
    borderRadius: 22,
    backgroundColor: 'transparent',
    borderColor: colors.border,
  },
  moreText: { fontFamily: font.medium, fontSize: 16, lineHeight: 22 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  emptyCircle: { position: 'absolute', backgroundColor: colors.accent, opacity: 0.2 },
  emptyTitle: {
    marginTop: 18,
    fontFamily: font.display,
    fontSize: 28,
    lineHeight: 34,
    color: colors.text,
    textAlign: 'center',
  },
  emptyTitleCompact: { marginTop: 12, fontSize: 24, lineHeight: 30 },
  emptyDetail: {
    marginTop: 10,
    maxWidth: 340,
    fontFamily: font.body,
    fontSize: 16,
    lineHeight: 22,
    color: colors.muted,
    textAlign: 'center',
  },
  emptyButton: { alignSelf: 'stretch', marginTop: 24, minHeight: 54, borderRadius: 18 },
  emptyButtonCompact: { marginTop: 18 },
  emptyButtonText: { fontFamily: font.bold, fontSize: 17, lineHeight: 24 },
  steps: { alignSelf: 'stretch', flexDirection: 'row', gap: 8, marginTop: 28 },
  step: {
    flex: 1,
    minWidth: 0,
    gap: 10,
    padding: 12,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  stepNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberText: { fontFamily: font.bold, fontSize: 13, lineHeight: 18, color: colors.accentText },
  stepText: { fontFamily: font.medium, fontSize: 13.5, lineHeight: 18, color: colors.text },
});
