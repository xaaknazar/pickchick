// TEST observations cannot create any commercial financial effect.
export function tipTopPayTestGrants(role, enabled) {
  if (role !== 'pickchick_app' || typeof enabled !== 'boolean')
    throw new Error('Invalid TEST payment grants');
  return enabled
    ? `GRANT SELECT,INSERT,UPDATE ON commerce_tiptoppay_test_payments TO ${role};`
    : `REVOKE ALL ON commerce_tiptoppay_test_payments FROM ${role};`;
}
