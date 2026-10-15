import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


# BSD script rejects Node's socket-based stdio; bridge it to a real PTY.
pid, terminal = pty.fork()
if pid == 0:
    fcntl.ioctl(sys.stdin.fileno(), termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)


def forward_signal(number, _frame):
    os.killpg(pid, number)


signal.signal(signal.SIGTERM, forward_signal)
signal.signal(signal.SIGINT, forward_signal)
inputs = [terminal, sys.stdin.fileno()]
try:
    while True:
        ready, _, _ = select.select(inputs, [], [])
        if terminal in ready:
            try:
                data = os.read(terminal, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if data:
                os.write(terminal, data)
            else:
                inputs.remove(sys.stdin.fileno())
finally:
    os.close(terminal)
    _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
