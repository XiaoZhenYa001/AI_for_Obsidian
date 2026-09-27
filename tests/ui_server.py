from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


@contextmanager
def serve(root, handler=QuietHandler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(handler, directory=str(root)))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
