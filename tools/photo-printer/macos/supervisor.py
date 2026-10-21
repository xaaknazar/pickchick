"""Keep the existing authenticated USB bridge available; never replay print jobs."""
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def private_ipv4(value):
    try:
        ip = ipaddress.IPv4Address(value)
        return any(ip in ipaddress.IPv4Network(net) for net in
                   ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
    except ipaddress.AddressValueError:
        return False


def probe(interface, uri, run=subprocess.run):
    """Only the configured physical interface and exact serial-number USB printer."""
    if not re.fullmatch(r'en\d+', interface):
        raise ValueError('A physical en interface is required')
    try:
        result = run(['/usr/sbin/ipconfig', 'getifaddr', interface],
                     capture_output=True, text=True, timeout=6, check=False)
        address = result.stdout.strip()
        if result.returncode or not private_ipv4(address):
            return None, 'waiting-network'
        result = run(['/usr/libexec/cups/backend/usb'],
                     capture_output=True, text=True, timeout=6, check=False)
        if result.returncode:
            return None, 'waiting-printer'
        for line in result.stdout.splitlines():
            fields = line.split(' ', 2)
            if (len(fields) == 3 and fields[:2] == ['direct', uri]
                    and re.search(r'CMD:[^;]*ESC/POS[;,]', line)):
                return address, 'ready'
        return None, 'waiting-printer'
    except (OSError, subprocess.TimeoutExpired):
        return None, 'waiting-hardware'


def write_private(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.tmp')
    with os.fdopen(os.open(temp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(value, f, indent=2)
        f.write('\n')
    os.replace(temp, path)


def acquire_lock(path):
    # Kernel lock survives neither a crash nor reboot. Never unlink a lock inode:
    # a second supervisor must not start while the first is draining a print.
    f = open(path, 'a+', encoding='utf-8')
    os.chmod(path, 0o600)
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        raise RuntimeError('Another photo supervisor owns this state') from None
    f.seek(0)
    f.truncate()
    f.write(str(os.getpid()))
    f.flush()
    return f


def kill_group(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


class Supervisor:
    def __init__(self, config, state, inspect=probe, launch=subprocess.Popen, cleanup=kill_group):
        self.config = config
        self.state = Path(state)
        self.inspect = inspect
        self.launch = launch
        self.cleanup = cleanup
        self.child = None
        self.address = None
        self.last_status = None
        self.running = True

    def status(self, value):
        if value != self.last_status:
            write_private(self.state / 'status.json', {
                'state': value, 'updatedAt': int(time.time()),
                'supervisorPid': os.getpid(), 'bind': self.address,
                'servicePid': self.child.pid if self.child else None,
                'confirmation': 'transport-only',
            })
            print('Photo bridge: ' + value, flush=True)
            self.last_status = value

    def stop_child(self):
        if self.child:
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    # USB single-send timeout is 15 seconds. A wedged process is
                    # stopped with its backend; durable UNKNOWN is never replayed.
                    self.cleanup(self.child.pid)
                    self.child.wait(timeout=5)
            # A crashed Node must not leave a USB backend writing concurrently
            # with the replacement service. Its existing job remains UNKNOWN.
            self.cleanup(self.child.pid)
            self.child = None
            self.address = None

    def tick(self):
        address, reason = self.inspect(self.config['interface'], self.config['service']['usbUri'])
        if self.child and (self.child.poll() is not None or address != self.address):
            self.stop_child()
            self.status('recovering')
        if not address:
            self.status(reason)
            return
        if not self.running:
            return
        if not self.child:
            service = {**self.config['service'], 'bind': address}
            write_private(self.state / 'runtime.json', service)
            self.child = self.launch(
                [self.config['node'], self.config['server'], str(self.state / 'runtime.json')],
                cwd=self.config['release'], start_new_session=True,
            )
            self.address = address
            self.status('service-started')

    def shutdown(self, *_):
        self.running = False


def main():
    if sys.platform != 'darwin':
        raise RuntimeError('macOS only')
    os.umask(0o077)
    config_path = Path(sys.argv[1]).resolve()
    config = json.loads(config_path.read_text())
    state = config_path.parent
    lock = acquire_lock(state / 'supervisor.lock')
    manager = Supervisor(config, state)
    signal.signal(signal.SIGTERM, manager.shutdown)
    signal.signal(signal.SIGINT, manager.shutdown)
    # AC-only assertion; display can sleep. Closing the lid or powering off is
    # not a supported always-on configuration. No global pmset setting changes.
    awake = subprocess.Popen(['/usr/bin/caffeinate', '-s', '-w', str(os.getpid())])
    try:
        while manager.running:
            manager.tick()
            for _ in range(10):
                if not manager.running:
                    break
                time.sleep(.5)
    finally:
        manager.stop_child()
        manager.status('stopped')
        awake.terminate()
        awake.wait(timeout=5)
        lock.close()


if __name__ == '__main__':
    main()
