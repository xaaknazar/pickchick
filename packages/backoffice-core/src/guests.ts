import type { GuestContact } from './stops.js';

/**
 * «Гости» of the back office (owner 15.11.2026): who the guest is instead of an id.
 *
 * The app asks only for a name («Как к вам обращаться»), birth date and gender, so there is no
 * surname. A manager grant sees the full phone and the birth date; every other role (analyst,
 * shift manager, accountant) sees the name and a masked phone, owner decision card 15.11.
 */
export interface GuestView {
  name: string | null;
  phone: string | null;
  phone_masked: boolean;
  birth_date: string | null;
}

/** +77012345678 -> +7 701 ••• •• 78; anything shorter than 6 digits is hidden completely. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '•••';
  const country = digits.length > 10 ? digits.slice(0, digits.length - 10) : '';
  const local = digits.slice(-10);
  return `${country ? `+${country} ` : ''}${local.slice(0, 3)} ••• •• ${local.slice(-2)}`;
}

/** +77012345678 -> +7 701 234 56 78 (Kazakhstan numbers); other forms are returned as stored. */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 11) return phone;
  return `+${digits[0]} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 9)} ${digits.slice(9)}`;
}

export function guestView(read: () => GuestContact, full: boolean): GuestView {
  let contact: GuestContact;
  try {
    contact = read();
  } catch {
    // A row that cannot be decrypted (rotated key, partial write) stays in the list without contacts.
    contact = { phone: null, nickname: null, birth_date: null };
  }
  const name = contact.nickname?.trim() || null;
  if (!contact.phone) return { name, phone: null, phone_masked: false, birth_date: null };
  return full
    ? {
        name,
        phone: formatPhone(contact.phone),
        phone_masked: false,
        birth_date: contact.birth_date,
      }
    : { name, phone: maskPhone(contact.phone), phone_masked: true, birth_date: null };
}
