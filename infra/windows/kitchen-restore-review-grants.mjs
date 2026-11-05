/** Additive grants after cloud072/edge025. Never resets existing application grants. */
export function kitchenRestoreReviewGrants(role, schema = 'public', scope = 'edge') {
  for (const value of [role, schema])
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid role/schema');
  const tables = {
    edge: [
      ['SELECT', 'fulfillment_restore_reviews,fulfillment_restore_decisions'],
      ['INSERT', 'fulfillment_restore_decisions'],
    ],
    receiver: [['SELECT,INSERT', 'pos_kitchen_restore_conflicts']],
    backoffice: [
      ['SELECT', 'pos_kitchen_restore_conflicts,pos_kitchen_restore_decisions'],
      ['INSERT', 'pos_kitchen_restore_decisions'],
    ],
  }[scope];
  if (!tables) throw new Error('Invalid grant scope');
  return tables
    .map(
      ([permission, names]) =>
        `GRANT ${permission} ON ${names
          .split(',')
          .map((n) => `"${schema}"."${n}"`)
          .join(',')} TO "${role}";`,
    )
    .join('\n');
}
