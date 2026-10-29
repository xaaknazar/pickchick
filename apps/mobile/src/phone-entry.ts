/**
 * The sign-in phone field shows «+7» itself and keeps the 10 digits after it. People also type
 * the number with its country code: «+7 700 ...», «7 700 ...», «8 700 ...».
 *
 * App Review 29.10.2026: typing «+77001234567» key by key reached 10 digits at «7700123456». That
 * is itself a valid Kazakhstan mobile number (they all start with 7), so the field showed the green
 * check and closed the keyboard; the last key never arrived and the code went to another number.
 */

/** The 10 digits after +7 that the field keeps for what was typed or pasted. */
export function phoneFieldDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  // «+7» / «7» / «8» and then a mobile number (it starts with 7): the field shows +7 itself.
  if (digits.length >= 11 && /^[78]7/.test(digits)) return digits.slice(1, 11);
  // Anything else: the first 10 digits (an extra key after a full number is ignored).
  return digits.slice(0, 10);
}

/**
 * Ten digits that may still be «7» or «8» plus the first nine digits of the number: the next key
 * decides. A mobile number starts with 7, so with a country code it starts with «77» or «87».
 * Such a value is not final: the keyboard stays open and an 11th digit drops the country code.
 */
export function phoneMayContinue(digits: string): boolean {
  return digits.length === 10 && /^[78]7/.test(digits);
}
