import { CommerceError } from './model.js';

/** Legacy clients retain CONFLICT; the opt-in HTTP profile exposes the precise cause. */
export class MenuChangedError extends CommerceError {
  constructor() {
    super('CONFLICT');
  }
}
