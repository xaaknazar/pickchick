// Product card presentation (kiosk redesign 2026-10-13, docs/design/kiosk-redesign-2026-10-13/
// product-and-payment.md, sections 1 and 2). Pure data only: no React Native, so node tests can
// load it. Prices, selections and their validity stay with cart.ts; this module only decides
// what the card shows: the composition pills, option names, the drink grid with its «Ещё N»
// tile, the drink shelves of the sheet and the summary of the choice.
import { SECTION_HITS, badgeOf } from './menu-presentation.ts';
import type { KioskModifierGroup, KioskProduct, KioskSelection } from './model';
import type { ProductCopy } from './productCopy';

type Option = KioskModifierGroup['options'][number];

/** Long dashes become the owner's plain hyphen; runs of spaces collapse. */
const tidy = (text: string) =>
  text
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN_WORD = /^[A-Za-z][A-Za-z0-9&'’.+-]*$/;
/** Lower-cases the first letter of a Cyrillic phrase ("Персик" -> "персик"); acronyms stay. */
const lower = (text: string) =>
  CYRILLIC.test(text.charAt(0)) && text.charAt(1) === text.charAt(1).toLowerCase()
    ? text.charAt(0).toLowerCase() + text.slice(1)
    : text;
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Lower-cases each capitalised Cyrillic word of a caption ("Манго-Ромашка" -> "манго-ромашка"). */
const lowerWords = (text: string) =>
  text.replace(
    /(^|[\s-])(\p{Script=Cyrillic})(?=\p{Ll})/gu,
    (_, edge: string, letter: string) => edge + letter.toLowerCase(),
  );

/** A trailing volume or weight: "0.5 л", "60 мл", "0,2 л", "90 г", "500 ml". */
const VOLUME = /\s*(\d+(?:[.,]\d+)?\s?(?:мл|л|г|кг|ml|l|g|kg))\.?$/iu;
/** A leading "signature" word that the tile shows as the caption ("фирменный"). */
const SIGNATURE = /^(фирменн(?:ый|ая|ое|ые)|фирмалық|signature)\s+(?=\S)/iu;
/** Names longer than this move their volume to the caption ("Coca-Cola Zero" / "0.5 л"). */
const LONG_NAME = 16;

export interface OptionText {
  /** Short name, Montserrat 800 on the tile ("Coca-Cola 0.5 л", "Fuse Tea"). */
  name: string;
  /** Second line in grey ("бутылка", "персик"), or empty. */
  caption: string;
}
/**
 * Splits a catalog option label into the tile's name and caption (design: «Coca-Cola 0.5 л» /
 * «бутылка», «Лимонад 0.5 л» / «фирменный», «Fuse Tea» / «персик»):
 * - text after the first ", " is the caption ("Coca-Cola 0.5 л, бутылка");
 * - Cyrillic words before a Latin brand: the brand is the caption ("Острый соус Pick Chick");
 * - a Latin brand before Cyrillic words of a drink with a volume: the brand and volume are the
 *   name, the flavour the caption ("Fuse Tea Персик 0.5 л" -> "Fuse Tea 0.5 л" / "персик");
 * - a leading "Фирменный" becomes the caption when there is no other one ("Фирменный лимонад
 *   0.5 л"); before a comma it is left out ("Фирменный холодный чай, сладкий");
 * - a name still longer than 16 letters gives its volume to the caption.
 * Anything else is the whole name with no caption.
 */
export function optionText(label: string): OptionText {
  const clean = tidy(label).replace(/\.$/, '');
  if (!clean) return { name: '', caption: '' };
  const comma = clean.search(/,\s/);
  let name = comma > 0 ? clean.slice(0, comma).trim() : clean;
  const tail = comma > 0 ? clean.slice(comma + 1).trim() : '';
  const captions: string[] = [];
  const volumeMatch = VOLUME.exec(name);
  const volume = volumeMatch && volumeMatch.index > 0 ? volumeMatch[1]!.replace(/\s+/, ' ') : '';
  let base = volume ? name.slice(0, volumeMatch!.index).trim() : name;
  const words = base.split(' ');
  const latin = words.map((word) => LATIN_WORD.test(word));
  const firstLatin = latin.indexOf(true);
  const lastCyrillic = words.map((word) => CYRILLIC.test(word)).lastIndexOf(true);
  if (
    !tail &&
    firstLatin > 0 &&
    latin.slice(firstLatin).every(Boolean) &&
    words.slice(0, firstLatin).every((word) => CYRILLIC.test(word))
  ) {
    // "Острый соус Pick Chick": the Cyrillic head names it, the brand is the caption.
    captions.push(words.slice(firstLatin).join(' '));
    base = words.slice(0, firstLatin).join(' ');
  } else if (!tail && volume && latin[0] && lastCyrillic > 0) {
    // "Fuse Tea Персик 0.5 л": the brand and volume name it, the flavour is the caption.
    const brand = latin.indexOf(false);
    captions.push(lowerWords(words.slice(brand).join(' ')));
    base = words.slice(0, brand).join(' ');
  } else {
    // "Фирменный лимонад 0.5 л": the word is the caption unless the label has its own.
    const signature = SIGNATURE.exec(base);
    if (signature && base.length > signature[0].length) {
      if (!tail) captions.push(signature[1]!.toLowerCase());
      base = upper(base.slice(signature[0].length));
    }
  }
  if (tail) captions.push(tail);
  name = [base, volume].filter(Boolean).join(' ');
  if (volume && base && name.length > LONG_NAME) {
    captions.unshift(volume);
    name = base;
  }
  return { name, caption: captions.join(', ') };
}

/** Descriptive words left out of a composition pill ("8 хрустящих куриных фингерсов"). */
const FILLER = new Set(
  [
    'хрустящий',
    'хрустящая',
    'хрустящие',
    'хрустящих',
    'хрустящими',
    'куриный',
    'куриные',
    'куриных',
    'куриными',
    'фирменный',
    'фирменная',
    'фирменные',
    'фирменных',
    'фирменным',
    'фирменного',
    'свежий',
    'свежего',
    'свежих',
    'свежим',
    'мягкий',
    'мягким',
    'поджаренный',
    'поджаренным',
  ].map((word) => word.normalize('NFC')),
);
/** "на выбор" and its translations end a part without adding to it. */
const CHOICE = /\s*(?:на выбор|по выбору|таңдау бойынша|таңдауыңызша|of your choice|of choice)$/iu;
/** Portion words dropped after a count of one ("1 порция фри" -> "фри"). */
const PORTION = /^(?:порция|порции|порций|шт|штука|portion|portions|pcs|дана)$/iu;
const MAX_PILL_WORDS = 4;
const MAX_PILL_LENGTH = 30;
function pill(part: string): string | null {
  let words = part
    .replace(CHOICE, '')
    .split(' ')
    .filter((word) => word && !FILLER.has(word.toLowerCase()));
  if (words[0] === '1' && words.length > 1) {
    words = words.slice(1);
    if (words.length > 1 && PORTION.test(words[0]!)) words = words.slice(1);
  }
  const text = lower(words.join(' '));
  // A pill names something: a word of three letters or more ("фри"), not a bare "0,5 л".
  return words.length >= 1 &&
    words.length <= MAX_PILL_WORDS &&
    text.length <= MAX_PILL_LENGTH &&
    /\p{L}{3}/u.test(text)
    ? text
    : null;
}
/**
 * Composition pills of the hero («4 фингерса», «фри», «соус», «тост», «коулслоу», «напиток»)
 * from the product's ingredients (or description). The text after the last colon is the list;
 * each sentence is split at commas and at "и" / "және" / "and". A sentence counts only when it
 * reads as a list: every part a short phrase (up to 4 words, 30 letters) and at least one part
 * starting with a count; a single phrase between full stops ("Сет на 20-22 человека.") is
 * skipped. Prose ("Есть сладкий и не сладкий, можно миксовать"), or a list mixed with it, gives
 * no pills, and the card shows the description instead. At most `max` pills, no repeats.
 */
export function compositionPills(text: string, max = 8): string[] {
  const clean = tidy(text);
  if (!clean) return [];
  const list = clean.includes(':') ? clean.slice(clean.lastIndexOf(':') + 1) : clean;
  const pills: string[] = [];
  for (const sentence of list.split(/[.!?;]+(?=\s|$)/)) {
    const parts = sentence
      .split(/,\s+|\s+(?:и|және|and|&)\s+/iu)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    const found = parts.map(pill);
    // A composition counts its parts ("4 фингерса"); prose with commas does not, and a text
    // mixing both is shown whole rather than as a partial list.
    if (found.some((item) => item === null) || !parts.some((part) => /^\d/.test(part))) return [];
    for (const item of found as string[])
      if (!pills.some((known) => known.toLowerCase() === item.toLowerCase())) pills.push(item);
  }
  return pills.length >= 2 ? pills.slice(0, max) : [];
}

/** Drink shelves of the sheet in order: «Газировка», «Холодный чай», «Лимонад, вода, сок». */
export const DRINK_SHELVES = ['soda', 'tea', 'other'] as const;
export type DrinkShelf = (typeof DRINK_SHELVES)[number];
const SODA = /^(?:cola|coca-cola|fanta|sprite|pepsi|mirinda|7up|schweppes)(?:-|$)/i;
const TEA = /^(?:fuse|iced-tea|tea|lipton)(?:-|$)/i;
/** Shelf of a drink option by its catalog id; lemonade, water, juice and anything new: "other". */
export const drinkShelf = (optionId: string): DrinkShelf =>
  SODA.test(optionId) ? 'soda' : TEA.test(optionId) ? 'tea' : 'other';
/** Options on their shelves (catalog order inside a shelf); empty shelves are left out. */
export function drinkShelves<T extends { id: string }>(options: readonly T[]) {
  return DRINK_SHELVES.map((shelf) => ({
    shelf,
    options: options.filter((option) => drinkShelf(option.id) === shelf),
  })).filter((entry) => entry.options.length > 0);
}

/** Drinks are a 5-column grid (two rows on the card); any other choice four across. */
export const isDrinkGroup = (group: Pick<KioskModifierGroup, 'id'>) => group.id === 'drink';
export const gridColumns = (group: Pick<KioskModifierGroup, 'id'>) => (isDrinkGroup(group) ? 5 : 4);
export interface OptionGrid<T> {
  /** Tiles on the card, in catalog order (a hidden pick takes the last slots). */
  shown: T[];
  /** Options only in the sheet, in catalog order. */
  hidden: T[];
}
/**
 * Card grid of a group with `slots` places (drinks: 5 x 2). Up to `slots` options are all shown.
 * More: the first `slots - 1` in catalog order and the last place is the «Ещё N · Показать все»
 * tile (N = hidden count). A picked option that is not among them takes the last of those places
 * (several picks: from the end), so the guest always sees what is chosen.
 */
export function optionGrid<T extends { id: string }>(
  options: readonly T[],
  picked: readonly string[],
  slots: number,
): OptionGrid<T> {
  if (options.length <= slots || slots < 2) return { shown: [...options], hidden: [] };
  const shown = options.slice(0, slots - 1);
  const missing = options.slice(slots - 1).filter((option) => picked.includes(option.id));
  let at = shown.length - 1;
  // From the end, the latest pick first, so the picks keep their catalog order.
  for (const option of [...missing].reverse()) {
    while (at >= 0 && picked.includes(shown[at]!.id)) at--;
    if (at < 0) break;
    shown[at] = option;
    at--;
  }
  const ids = new Set(shown.map((option) => option.id));
  return { shown, hidden: options.filter((option) => !ids.has(option.id)) };
}

/** Units picked in a group; an option stopped while the page is open no longer counts. */
export const groupCount = (group: KioskModifierGroup, selections: readonly KioskSelection[]) =>
  selections
    .filter(
      (s) =>
        s.group_id === group.id && group.options.some((o) => o.id === s.option_id && o.available),
    )
    .reduce((sum, s) => sum + s.quantity, 0);
export const groupComplete = (group: KioskModifierGroup, selections: readonly KioskSelection[]) => {
  const count = groupCount(group, selections);
  return count >= group.min && count <= group.max;
};
/**
 * The selections after the guest sets `optionId` of `group` to `quantity` (the same rule as the
 * former option groups): a single choice (max 1) replaces the group's pick, a multiple choice
 * changes that option only, and 0 takes it out.
 */
export function applyPick(
  group: Pick<KioskModifierGroup, 'id' | 'max'>,
  selections: readonly KioskSelection[],
  optionId: string,
  quantity: number,
): KioskSelection[] {
  const others = selections.filter(
    (s) => !(s.group_id === group.id && (group.max === 1 || s.option_id === optionId)),
  );
  return quantity > 0 ? [...others, { group_id: group.id, option_id: optionId, quantity }] : others;
}
/**
 * Groups shown as numbered sections. The «Добавить к заказу» list (an optional group of extras
 * with quantities) left the card: the smart upsell offers extras now. Its picks, if a cart line
 * being edited has any, stay in the line untouched.
 */
export const cardGroups = (product: Pick<KioskProduct, 'modifier_groups'>) =>
  product.modifier_groups.filter((group) => !(group.min === 0 && group.max > 1));
/** The first section still waiting for a choice. */
export const firstMissing = (
  groups: readonly KioskModifierGroup[],
  selections: readonly KioskSelection[],
) => groups.find((group) => !groupComplete(group, selections));

/** Section title: «Напиток» / «Соус» / «Размер» by group id, the catalog title otherwise. */
export function sectionTitle(group: KioskModifierGroup, t: ProductCopy) {
  const many = group.max > 1;
  if (group.id === 'drink') return many ? t.sectionDrinks : t.sectionDrink;
  if (group.id === 'sauce') return many ? t.sectionSauces : t.sectionSauce;
  if (group.id === 'size') return t.sectionSize;
  return tidy(group.title).replace(CHOICE, '') || t.chooseOption;
}
/** «Выберите соус»: what the panel asks for while a section is empty. */
export function chooseText(group: KioskModifierGroup, t: ProductCopy) {
  if (group.id === 'drink') return t.chooseDrink;
  if (group.id === 'sauce') return t.chooseSauce;
  if (group.id === 'size') return t.chooseSize;
  return t.chooseOption;
}

export interface Picked {
  option: Option;
  quantity: number;
  /** "Coca-Cola 0.5 л", or "Фирменный соус × 2". */
  text: string;
}
/** Picks of a group in its catalog order (stopped options left out). */
export function picked(group: KioskModifierGroup, selections: readonly KioskSelection[]): Picked[] {
  return group.options.flatMap((option) => {
    if (!option.available) return [];
    const quantity = selections
      .filter((s) => s.group_id === group.id && s.option_id === option.id)
      .reduce((sum, s) => sum + s.quantity, 0);
    if (quantity <= 0) return [];
    const name = optionText(option.label).name || tidy(option.label);
    return [{ option, quantity, text: quantity > 1 ? `${name} × ${quantity}` : name }];
  });
}
/** Surcharge of a group's picks in minor units ("0" when everything is included). */
export const surchargeMinor = (items: readonly Picked[]) =>
  items
    .reduce((sum, item) => sum + BigInt(item.option.price_delta_minor) * BigInt(item.quantity), 0n)
    .toString();
/** Names in a value pill: two picks, then "+n" for the rest. */
export function pickedNames(items: readonly Picked[]) {
  const names = items.map((item) => item.text);
  return names.length > 2
    ? `${names.slice(0, 2).join(', ')} +${names.length - 2}`
    : names.join(', ');
}
/** Panel line over the status: the picks of every section, «Coca-Cola 0.5 л · Фирменный соус». */
export function selectionSummary(
  groups: readonly KioskModifierGroup[],
  selections: readonly KioskSelection[],
) {
  return groups
    .map((group) => pickedNames(picked(group, selections)))
    .filter(Boolean)
    .join(' · ');
}

/** Hero label: the card badge (Pick Combo «ХИТ НЕДЕЛИ»), else the section hit label. */
export type HeroBadge = {
  label:
    'hit' | 'hitDuo' | 'hitSets' | 'hitExtras' | 'hitDrinks' | 'newTag' | 'spicyTag' | 'recipeTag';
  tone: 'hit' | 'new';
};
export function productBadge(productId: string): HeroBadge | null {
  const badge = badgeOf(productId);
  if (badge === 'hit') return { label: 'hit', tone: 'hit' };
  if (badge === 'new') return { label: 'newTag', tone: 'new' };
  if (badge === 'spicy') return { label: 'spicyTag', tone: 'new' };
  if (badge === 'recipe') return { label: 'recipeTag', tone: 'new' };
  const hit = Object.values(SECTION_HITS).find((entry) => entry.productId === productId);
  return hit ? { label: hit.label, tone: 'hit' } : null;
}
/** Kind of product for the header caption («Комбо · 520 г») and the "included" status. */
export type ProductKind = 'combo' | 'duo' | 'set' | 'side' | 'drink';
export const productKind = (category: string): ProductKind =>
  category === 'Комбо'
    ? 'combo'
    : category === 'На двоих'
      ? 'duo'
      : category === 'На компанию'
        ? 'set'
        : category === 'Напитки'
          ? 'drink'
          : 'side';
export function kindLabel(kind: ProductKind, t: ProductCopy) {
  return {
    combo: t.kindCombo,
    duo: t.kindDuo,
    set: t.kindSet,
    side: t.kindSide,
    drink: t.kindDrink,
  }[kind];
}
/** Status of a free option: «Входит в комбо» (combo, duo), «Входит в набор», «Без доплаты». */
export function includedLabel(kind: ProductKind, t: ProductCopy) {
  return kind === 'combo' || kind === 'duo' ? t.inCombo : kind === 'set' ? t.inSet : t.noCharge;
}
/** Serving label without the catalog's "-" placeholder. */
export const servingOf = (product: Pick<KioskProduct, 'serving_label'>) => {
  const serving = tidy(product.serving_label);
  return serving === '-' ? '' : serving;
};
/** «520 г · 1240 ккал». */
export function servingLine(
  product: Pick<KioskProduct, 'serving_label' | 'nutrition'>,
  kcal: string,
) {
  return [servingOf(product), `${product.nutrition.energy_kcal} ${kcal}`]
    .filter(Boolean)
    .join(' · ');
}
