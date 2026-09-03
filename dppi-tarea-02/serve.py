import os
import sys
import socket
import time
import logging
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DOC_ROOT = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(DOC_ROOT, "server.log")

logging.basicConfig(filename=LOG_FILE, level=logging.INFO, format="%(asctime)s - %(message)s", force=True)

class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True
    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        self.allow_reuse_address = True
        super().server_bind()

class CustomHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DOC_ROOT, **kwargs)

    def log_message(self, format, *args):
        logging.info("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), format % args))

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

if __name__ == '__main__':
    port = 8000
    while True:
        try:
            server = DualStackServer(('::', port), CustomHandler)
            logging.info(f"Server started on port {port}")
            server.serve_forever()
        except Exception as e:
            logging.error(f"Server loop error: {e}")
            time.sleep(1)
