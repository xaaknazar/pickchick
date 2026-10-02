#!/usr/bin/env python3
"""Guarded schema031 -> 032 order feedback; preserve the live checkout and bank policy.

Retains exact-source CI, maintenance, encrypted backup/restore rehearsal and
existing data fingerprints. Only the feedback table and bounded app grants may
be added; cashier, receipts and the independently deployed bank worker stay intact.
"""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('feedback_comment_base', Path(__file__).with_name('release-checkout-order-comment.py'))
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)
market, require = base.market, base.require
BASELINE = 'f0ce904ea1d14438b7574c9f69fdf7647d108afa'
PUBLIC_BASELINE = 'c48368033dc903d88e478165818fe327fcb93322'
GATEWAY_BASELINE = 'd50c27fa23f788972e0e81cfdeeafac1c33ed9fc75f6be7b845faa0e30712569'
MIGRATION = '032_cloud_order_feedback.sql'
FEEDBACK_TABLE = 'commerce_order_feedback'
GET_PATHS = "path('/v1/customer-checkout/config', '/v1/customer-checkout/orders', '/v1/customer-checkout/availability')"
PAYMENT_ROUTE = "(method('POST') && path_regexp('^/v1/customer-checkout/orders/[a-f0-9-]{36}/payment$'))"
FEEDBACK_ROUTE = "((method('GET') || method('POST')) && path_regexp('^/v1/customer-checkout/orders/[a-f0-9-]{36}/feedback$'))"


def extend_feedback(text):
    require(text.count('\t@customer_checkout {') == 1 and
            text.count(GET_PATHS) == 1 and text.count(PAYMENT_ROUTE + '`') == 1 and
            '/feedback' not in text, 'Unexpected feedback gateway baseline')
    # Transform only the already reviewed matcher; retain live handlers, mounts,
    # authentication, availability, fiscal policy and proxy deadlines verbatim.
    return text.replace(GET_PATHS, GET_PATHS[:-1] + ", '/v1/customer-checkout/feedback')").replace(
        PAYMENT_ROUTE + '`', PAYMENT_ROUTE + ' || ' + FEEDBACK_ROUTE + '`')


def verify_feedback_acl(before, after):
    require(not any(row['name'] == FEEDBACK_TABLE for row in before), 'Feedback table already in baseline ACL')
    unchanged = [row for row in after if row['name'] != FEEDBACK_TABLE]
    require(unchanged == before, 'Existing API permissions changed')
    added = [row for row in after if row['name'] == FEEDBACK_TABLE]
    expected = [
        {'name': FEEDBACK_TABLE, 'kind': 'r', 'column': column, 'privilege': privilege, 'grantable': False}
        for column, privilege in [(None, 'INSERT'), (None, 'SELECT'),
                                  ('comment', 'UPDATE'), ('rating', 'UPDATE'), ('updated_at', 'UPDATE')]
    ]
    key = lambda row: (row['name'], row['kind'], row['column'] or '', row['privilege'], row['grantable'])
    require(sorted(map(key, added)) == sorted(map(key, expected)), 'Unexpected feedback ACL')


class Release(base.Release):
    snapshot = market.Release.snapshot
    additions = {}

    def __init__(self, args):
        require(args.expected_api_sha == BASELINE and args.expected_public_sha == PUBLIC_BASELINE and
                args.expected_gateway_sha256 == GATEWAY_BASELINE, 'Unreviewed order-feedback baseline')
        profile = market.ReleaseProfile('commerce-feedback-schema032', BASELINE, PUBLIC_BASELINE,
            31, (MIGRATION,), market.TRANSPORT_PROFILE.ci_jobs, frozenset(),
            'commerce-feedback-release', (), exact_ci_jobs=True)
        market.Release.__init__(self, args, profile)

    def web_manifest_source(self):
        return BASELINE

    def gateway_candidate(self, text):
        return extend_feedback(text)

    def verify_data(self, before):
        expected = before['ledger'] + [{'version': MIGRATION, 'scope': 'cloud',
            'checksum': market.digest((market.REPO/'db/cloud/migrations'/MIGRATION).read_bytes())}]
        require(self.ledger() == expected, 'Unexpected migration delta')
        market.compare_existing(before['data'], self.snapshot(), additions=True, new_tables={FEEDBACK_TABLE})
        verify_feedback_acl(before['acl'], self.acl())
        require(self.psql(market.DB,
            "SELECT has_table_privilege('pickchick_app','commerce_captures','INSERT') OR "
            "has_column_privilege('pickchick_app','commerce_orders','total_minor','UPDATE')") == 'f',
            'HTTP application acquired bank or price mutation authority')
        require(self.psql(market.DB,
            "SELECT has_table_privilege('pickchick_kaspi_worker','commerce_order_feedback',"
            "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR "
            "has_any_column_privilege('pickchick_kaspi_worker','commerce_order_feedback','SELECT,INSERT,UPDATE,REFERENCES')") == 'f',
            'Bank worker acquired feedback authority')

    def verify_public(self):
        super().verify_public()
        sample = '/v1/customer-checkout/orders/00000000-0000-4000-8000-000000000000/feedback'
        for path, method in [('/v1/customer-checkout/feedback', 'GET'), (sample, 'GET'), (sample, 'POST')]:
            require(self.http(path, method=method)[0] == 401, 'Anonymous feedback accepted or route unavailable')


if __name__ == '__main__':
    base.base.base.rollout.owner.base.Release = Release
    base.base.base.rollout.owner.base.main()
