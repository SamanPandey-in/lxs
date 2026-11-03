#!/usr/bin/env python3
"""Small, bounded RESP2 decoy. It never persists data or performs external actions."""
import datetime, json, os, socket, socketserver, threading

DECOY = os.getenv('LXS_DECOY_ID', 'redis-decoy')
SEED = os.getenv('LXS_REDIS_SEED', 'finance')
REQUIRE = os.getenv('LXS_REDIS_REQUIRE_PASSWORD') == '1'
LOG = "/var/log/lxs/redis.jsonl"
LOCK = threading.Lock()
LIMIT = 20000
try:
    COUNT = sum(1 for _ in open(LOG, encoding='utf-8'))
except OSError:
    COUNT = 0
KEYS = ([('finance:users', '2'), ('finance:payments:recent', '3'), ('finance:session:fake-01', 'active')]
        if SEED == 'finance' else [('shop:users', '2'), ('shop:orders:recent', '3'), ('shop:session:fake-01', 'active')])
os.makedirs(os.path.dirname(LOG), exist_ok=True)
open(LOG, 'a', encoding='utf-8').close()

def log(ip, port, cmd, outcome='success'):
    global COUNT
    with LOCK:
        if COUNT >= LIMIT: return
        COUNT += 1
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        row = {'ts': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'src_ip': ip,
               'src_port': port, 'command': cmd[:64], 'outcome': outcome}
        with open(LOG, 'a', encoding='utf-8') as f: f.write(json.dumps(row, separators=(',', ':'))+'\n')

def read_resp(r):
    line = r.readline(8193)
    if not line or len(line) > 8192: return None
    if line.startswith(b'*'):
        n = int(line[1:].strip());
        if n < 1 or n > 64: return None
        out=[]
        for _ in range(n):
            h=r.readline(8193)
            if not h.startswith(b'$'): return None
            size=int(h[1:].strip())
            if size < 0 or size > 4096: return None
            v=r.read(size); r.read(2); out.append(v.decode('utf-8','replace'))
        return out
    if line.startswith(b'+') or line.startswith(b'$'):
        return [line[1:].strip().decode('utf-8','replace')]
    return None

class Handler(socketserver.StreamRequestHandler):
    timeout = 15
    def handle(self):
        authed = not REQUIRE
        for _ in range(256):
            try: args=read_resp(self.rfile)
            except Exception: return
            if not args: return
            cmd=args[0].upper()
            if cmd in ('AUTH','PING','INFO','CLIENT','SELECT','COMMAND'):
                safe=cmd
            else: safe=cmd
            if cmd == 'AUTH':
                authed = len(args) >= 2 and args[-1] in ('lxs_fake_only','redis_fake_only')
                log(self.client_address[0], self.client_address[1], 'AUTH', 'success' if authed else 'failure')
                self.wfile.write(b'+OK\r\n' if authed else b'-ERR invalid password\r\n'); continue
            if not authed:
                log(self.client_address[0], self.client_address[1], safe, 'failure'); self.wfile.write(b'-NOAUTH Authentication required.\r\n'); continue
            log(self.client_address[0], self.client_address[1], safe)
            if cmd == 'PING': self.wfile.write(b'+PONG\r\n')
            elif cmd == 'INFO': self.wfile.write(b'$39\r\n# Server\r\nredis_version:7.2.0\r\n\r\n')
            elif cmd == 'AUTH': self.wfile.write(b'+OK\r\n')
            elif cmd in ('CLIENT','SELECT','COMMAND'): self.wfile.write(b'+OK\r\n')
            elif cmd == 'KEYS':
                values=[k for k,_ in KEYS if len(args)<2 or args[1] == '*' or args[1].strip('*') in k]
                self.wfile.write(f'*{len(values)}\r\n'.encode()+b''.join(f'${len(v)}\r\n{v}\r\n'.encode() for v in values))
            elif cmd == 'SCAN':
                values=[k for k,_ in KEYS]
                self.wfile.write(b'*2\r\n$1\r\n0\r\n'+f'*{len(values)}\r\n'.encode()+b''.join(f'${len(v)}\r\n{v}\r\n'.encode() for v in values))
            elif cmd == 'GET':
                value=dict(KEYS).get(args[1] if len(args)>1 else '')
                self.wfile.write(b'$-1\r\n' if value is None else f'${len(value)}\r\n{value}\r\n'.encode())
            elif cmd in ('HGET','LRANGE','SMEMBERS','ZRANGE','HGETALL'):
                self.wfile.write(b'*0\r\n')
            elif cmd in ('SET','DEL','INCR','LPUSH','FLUSHALL','FLUSHDB','CONFIG','EVAL','SAVE','BGSAVE','REPLICAOF','SLAVEOF'):
                self.wfile.write(b'+OK\r\n')
            else: self.wfile.write(b'-ERR unknown command\r\n')

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True
    request_queue_size=64
    clients=threading.BoundedSemaphore(64)

    def process_request(self, request, client_address):
        if not self.clients.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.clients.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.clients.release()

if __name__ == '__main__':
    with Server(('0.0.0.0',6379), Handler) as s: s.serve_forever()
