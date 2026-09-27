"""Start both services. Use --ip for USB tethering or another LAN interface."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ip", help="Mac address reachable from the iPhone")
    args = parser.parse_args()
    try:
        interfaces = subprocess.check_output(["ifconfig"], text=True)
        addresses = re.findall(r"\binet (\d+\.\d+\.\d+\.\d+)", interfaces)
    except (OSError, subprocess.CalledProcessError):
        addresses = socket.gethostbyname_ex(socket.gethostname())[2]
    addresses = [ip for ip in addresses if ip != "127.0.0.1" and ip != "192.0.0.2"]
    if args.ip:
        ipaddress.ip_address(args.ip)
        address = args.ip
    elif len(addresses) == 1:
        address = addresses[0]
    else:
        print("Choose an address reachable from your phone:", ", ".join(addresses) or "none found")
        print("Run again with --ip ADDRESS. USB addresses only work while tethered.")
        return 1
    python = ROOT / ".venv/bin/python"
    if not python.exists():
        print("Create .venv and install server/requirements.txt first.")
        return 1
    environment = dict(os.environ, EXPO_PUBLIC_SERVER_URL=f"ws://{address}:8765/ws",
                       REACT_NATIVE_PACKAGER_HOSTNAME=address)
    processes = []
    try:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=2) as response:
                if not json.load(response).get("ok"):
                    raise RuntimeError("Port 8765 is occupied by a different server")
            print("Reusing server on 8765. Restart that server separately after code changes.")
        except OSError:
            processes.append(subprocess.Popen([str(python), "server/main.py", "--vision-provider", "off"], cwd=ROOT))
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", 8081)) == 0:
                print("Metro already uses port 8081. Stop it in its terminal and rerun this launcher.")
                return 1
        print(f"Phone server URL: ws://{address}:8765/ws", flush=True)
        metro = subprocess.Popen(["npx", "expo", "start", "--dev-client", "--lan"],
                                 cwd=ROOT / "mobile", env=environment)
        processes.append(metro)
        while metro.poll() is None:
            if any(p.poll() is not None for p in processes[:-1]):
                raise RuntimeError("Server stopped. See its error above.")
            try:
                metro.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
