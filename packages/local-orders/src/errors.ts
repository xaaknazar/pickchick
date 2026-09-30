export class OrderError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'UNAUTHORIZED'
      | 'FORBIDDEN'
      | 'CONFLICT'
      | 'NOT_FOUND'
      | 'QUOTE_EXPIRED'
      | 'MENU_CHANGED'
      | 'BRANCH_UNAVAILABLE'
      | 'ITEM_STOPPED'
      | 'CASH_SHIFT_REQUIRED'
      | 'SERVICE_MODE_DISABLED'
      | 'KITCHEN_UNAVAILABLE'
      | 'ORDER_IN_PRODUCTION',
  ) {
    super(code);
  }
}
export const orderErrorStatus = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  NOT_FOUND: 404,
  QUOTE_EXPIRED: 409,
  MENU_CHANGED: 409,
  BRANCH_UNAVAILABLE: 409,
  ITEM_STOPPED: 409,
  CASH_SHIFT_REQUIRED: 409,
  SERVICE_MODE_DISABLED: 409,
  KITCHEN_UNAVAILABLE: 409,
  ORDER_IN_PRODUCTION: 409,
} as const;
