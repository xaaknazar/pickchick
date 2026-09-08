"""Synthetic signed-in identity for journeys that require an account (never an API credential)."""
import json

ACCOUNT_KEY = 'pickchick.demo.profile.v1'
ACCOUNT = {'version': 2, 'kind': 'local_demo', 'phone': '+77000000000',
           'createdAt': 1700000000000,
           'profile': {'nickname': 'UI test', 'birthDate': None, 'gender': None, 'completedAt': None}}


def signed_in(context):
    context.add_init_script("""(() => {
      if (!sessionStorage.getItem('pickchick.test.account-seeded')) {
        localStorage.setItem(%s, JSON.stringify(%s));
        sessionStorage.setItem('pickchick.test.account-seeded', '1');
      }
    })();""" % (json.dumps(ACCOUNT_KEY), json.dumps(ACCOUNT)))
