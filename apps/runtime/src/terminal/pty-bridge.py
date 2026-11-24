"""Runs a login shell on a pty and relays bytes over stdin/stdout.

Usage: pty-bridge.py SHELL CWD. File descriptor 3 carries resize requests as "COLS ROWS\n".
Node has no built-in pty, and a native addon would not install on every Node version,
so the web terminal talks to this small standard-library helper instead.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(fd, data):
    while data:
        written = os.write(fd, data)
        data = data[written:]


def main():
    shell, cwd = sys.argv[1], sys.argv[2]
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvp(shell, [shell, "-l"])

    def resize(cols, rows):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    resize(80, 24)
    watched = [0, master, 3]
    control = b""
    try:
        while True:
            ready, _, _ = select.select(watched, [], [])
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                write_all(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    break
                write_all(master, data)
            if 3 in ready:
                data = os.read(3, 4096)
                if not data:
                    watched.remove(3)
                    continue
                control += data
                while b"\n" in control:
                    line, control = control.split(b"\n", 1)
                    try:
                        cols, rows = (int(part) for part in line.split())
                        resize(max(1, min(cols, 1000)), max(1, min(rows, 1000)))
                    except ValueError:
                        pass
    finally:
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


main()
