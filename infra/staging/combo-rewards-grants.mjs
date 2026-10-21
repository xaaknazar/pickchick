/** Apply alongside cloud060 to the API and its payment/refund worker roles. */
export function comboRewardsGrants(role) {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(role)) throw new Error('Invalid PostgreSQL role');
  return `
GRANT SELECT,INSERT ON combo_reward_programs,combo_reward_accruals,combo_reward_redemptions,combo_reward_events,commerce_refund_lines TO ${role};
GRANT UPDATE(units,refund_review,updated_at) ON combo_reward_accruals TO ${role};
GRANT UPDATE(state,updated_at) ON combo_reward_redemptions TO ${role};`;
}
