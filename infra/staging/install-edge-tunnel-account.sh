#!/usr/bin/env bash
# Root-only setup of a new key-only forwarding identity. Never change the ops user.
set -euo pipefail
export LC_ALL=C
[[ $EUID == 0 ]] || { echo 'Run from the VPS root console.' >&2; exit 1; }
[[ $# == 1 && -f $1 && ! -L $1 ]] || { echo 'Supply one public key file.' >&2; exit 1; }
account=pickchick-edge-link
config=/etc/ssh/sshd_config.d/60-pickchick-edge-link.conf
home=/var/lib/pickchick-edge-link
getent passwd "$account" >/dev/null && { echo 'Account exists; inspect instead of overwriting.' >&2; exit 1; }
[[ ! -e $config && ! -e $home ]] || { echo 'Setup path exists; inspect it.' >&2; exit 1; }
[[ $(awk 'NF {n++} END {print n+0}' "$1") == 1 ]] || exit 1
key=$(awk 'NF {print $1 " " $2}' "$1")
[[ $key =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,2}$ ]] || exit 1
ssh-keygen -lf "$1" >/dev/null
grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/\*.conf' /etc/ssh/sshd_config
ss -ltn | grep -q '127.0.0.1:13100' || { echo 'Private API listener is absent.' >&2; exit 1; }

# Account remains keyless until the effective server policy has been checked.
useradd --system --create-home --home-dir "$home" --shell /usr/sbin/nologin "$account"
chmod 750 "$home"
umask 077
(set -o noclobber; cat > "$config" <<'CONFIG'
Match User pickchick-edge-link
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:13100
    PermitListen none
    MaxSessions 0
    PermitTTY no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
Match all
CONFIG
)
chmod 644 "$config"
/usr/sbin/sshd -t
effective=$(/usr/sbin/sshd -T -C user="$account",host=localhost,addr=127.0.0.1)
for expected in 'authenticationmethods publickey' 'passwordauthentication no' \
  'kbdinteractiveauthentication no' 'allowtcpforwarding local' \
  'permitopen 127.0.0.1:13100' 'permitlisten none' 'maxsessions 0' \
  'permittty no' 'allowagentforwarding no' 'x11forwarding no' 'permittunnel no'; do
  grep -Fxq "$expected" <<< "$effective" || { echo "Policy differs: $expected" >&2; exit 1; }
done
systemctl reload ssh
install -d -m 700 -o "$account" -g "$account" "$home/.ssh"
printf 'restrict,port-forwarding,permitopen="127.0.0.1:13100",command="/usr/sbin/nologin" %s\n' "$key" > "$home/.ssh/authorized_keys"
chown "$account:$account" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
echo 'READY: key-only edge tunnel to 127.0.0.1:13100; shell and remote forwarding disabled.'
